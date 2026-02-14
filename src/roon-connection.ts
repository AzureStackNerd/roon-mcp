import RoonApi from "node-roon-api";
import RoonApiTransport from "node-roon-api-transport";
import RoonApiBrowse from "node-roon-api-browse";
import RoonApiStatus from "node-roon-api-status";
import type { RoonCore } from "node-roon-api";
import type { Zone } from "node-roon-api-transport";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROON_HOST = process.env.ROON_HOST || "192.168.1.100";
const ROON_PORT = (() => {
  const port = parseInt(process.env.ROON_PORT || "9100", 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`[roon-mcp] Invalid ROON_PORT: ${process.env.ROON_PORT}. Using default 9100.`);
    return 9100;
  }
  return port;
})();

// Fixed path for config.json so pairing token persists across restarts
// regardless of CWD when Claude Desktop launches the process
const CONFIG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

function loadPersistedState(): Record<string, unknown> {
  try {
    const content = readFileSync(CONFIG_PATH, { encoding: "utf8" });
    return JSON.parse(content)?.roonstate || {};
  } catch {
    return {};
  }
}

function savePersistedState(state: Record<string, unknown>): void {
  try {
    let config: Record<string, unknown> = {};
    try {
      const content = readFileSync(CONFIG_PATH, { encoding: "utf8" });
      config = JSON.parse(content) || {};
    } catch {
      // file doesn't exist yet
    }
    config.roonstate = state;
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, "    "));
  } catch (e) {
    console.error("[roon-mcp] Failed to save config:", e);
  }
}

export class RoonConnection {
  private roon: RoonApi;
  private status: RoonApiStatus;
  private core: RoonCore | null = null;
  private zones: Map<string, Zone> = new Map();

  constructor() {
    this.roon = new RoonApi({
      extension_id: "com.roon-mcp.claude",
      display_name: "Roon MCP for Claude",
      display_version: "1.0.0",
      publisher: "roon-mcp",
      email: "noreply@roon-mcp.local",
      log_level: "none",

      get_persisted_state: loadPersistedState,
      set_persisted_state: savePersistedState,

      core_paired: (core) => {
        console.error(`[roon-mcp] Paired with core: ${core.display_name}`);
        this.core = core;
        this.subscribeZones();
      },

      core_unpaired: (core) => {
        console.error(`[roon-mcp] Unpaired from core: ${core.display_name}`);
        this.core = null;
        this.zones.clear();
      },
    });

    this.status = new RoonApiStatus(this.roon);

    this.roon.init_services({
      required_services: [RoonApiTransport, RoonApiBrowse],
      provided_services: [this.status],
    });
  }

  connect(): void {
    console.error(`[roon-mcp] Connecting to Roon Core at ${ROON_HOST}:${ROON_PORT}...`);
    this.status.set_status("Connecting...", false);

    const doConnect = () => {
      this.roon.ws_connect({
        host: ROON_HOST,
        port: ROON_PORT,
        onclose: () => {
          console.error("[roon-mcp] Connection lost, reconnecting in 3s...");
          this.core = null;
          this.zones.clear();
          setTimeout(doConnect, 3000);
        },
        onerror: () => {
          console.error("[roon-mcp] WebSocket error");
        },
      });
    };

    doConnect();
  }

  private subscribeZones(): void {
    const transport = this.getTransportUnsafe();
    if (!transport) return;

    transport.subscribe_zones((response, msg) => {
      if (response === "Subscribed" && msg.zones) {
        this.zones.clear();
        for (const zone of msg.zones) {
          this.zones.set(zone.zone_id, zone);
        }
        console.error(`[roon-mcp] Subscribed to ${this.zones.size} zone(s)`);
        this.status.set_status("Connected", false);
      } else if (response === "Changed") {
        if (msg.zones_removed) {
          for (const id of msg.zones_removed) {
            this.zones.delete(id);
          }
        }
        if (msg.zones_added) {
          for (const zone of msg.zones_added) {
            this.zones.set(zone.zone_id, zone);
          }
        }
        if (msg.zones_changed) {
          for (const zone of msg.zones_changed) {
            this.zones.set(zone.zone_id, zone);
          }
        }
        if (msg.zones_seek_changed) {
          for (const update of msg.zones_seek_changed) {
            const zone = this.zones.get(update.zone_id);
            if (zone) {
              if (zone.now_playing) {
                zone.now_playing.seek_position = update.seek_position;
              }
              zone.queue_time_remaining = update.queue_time_remaining;
            }
          }
        }
      }
    });
  }

  private getTransportUnsafe(): RoonApiTransport | null {
    if (!this.core) return null;
    return this.core.services.RoonApiTransport as RoonApiTransport | undefined ?? null;
  }

  getTransport(): RoonApiTransport {
    const transport = this.getTransportUnsafe();
    if (!transport) {
      throw new Error(
        "Not connected to Roon. Please approve the extension in Roon Settings > Extensions.",
      );
    }
    return transport;
  }

  private getBrowseUnsafe(): RoonApiBrowse | null {
    if (!this.core) return null;
    return this.core.services.RoonApiBrowse as RoonApiBrowse | undefined ?? null;
  }

  getBrowse(): RoonApiBrowse {
    const browse = this.getBrowseUnsafe();
    if (!browse) {
      throw new Error(
        "Not connected to Roon. Please approve the extension in Roon Settings > Extensions.",
      );
    }
    return browse;
  }

  isConnected(): boolean {
    return this.core !== null;
  }

  getZones(): Zone[] {
    return Array.from(this.zones.values());
  }

  findZone(nameOrId: string): Zone | null {
    // Try exact zone_id match first
    const byId = this.zones.get(nameOrId);
    if (byId) return byId;

    // Try case-insensitive display_name match
    const lower = nameOrId.toLowerCase();
    for (const zone of this.zones.values()) {
      if (zone.display_name.toLowerCase() === lower) return zone;
    }

    // Try partial match
    for (const zone of this.zones.values()) {
      if (zone.display_name.toLowerCase().includes(lower)) return zone;
    }

    return null;
  }

  findZoneOrThrow(nameOrId: string): Zone {
    const zone = this.findZone(nameOrId);
    if (!zone) {
      const available = this.getZones()
        .map((z) => z.display_name)
        .join(", ");
      throw new Error(
        `Zone '${nameOrId}' not found. Available zones: ${available || "(none - is Roon paired?)"}`,
      );
    }
    return zone;
  }
}

export const roonConnection = new RoonConnection();
