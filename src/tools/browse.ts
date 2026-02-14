import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roonConnection } from "../roon-connection.js";
import type RoonApiBrowse from "node-roon-api-browse";
import type {
  BrowseOptions,
  BrowseResult,
  LoadOptions,
  LoadResult,
  BrowseItem,
} from "node-roon-api-browse";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

let sessionCounter = 0;

function newSessionKey(): string {
  return `mcp-${++sessionCounter}`;
}

function promisifyBrowse(
  browse: RoonApiBrowse,
  opts: BrowseOptions,
): Promise<{ error: false | string; body: BrowseResult }> {
  return new Promise((resolve) =>
    browse.browse(opts, (error, body) => resolve({ error, body })),
  );
}

function promisifyLoad(
  browse: RoonApiBrowse,
  opts: LoadOptions,
): Promise<{ error: false | string; body: LoadResult }> {
  return new Promise((resolve) =>
    browse.load(opts, (error, body) => resolve({ error, body })),
  );
}

/**
 * Strip Roon's internal link format from text.
 * Roon subtitles may contain `[[12345|Artist Name]]` — extract just the name.
 */
function stripRoonLinks(text: string): string {
  return text.replace(/\[\[\d+\|([^\]]+)\]\]/g, "$1");
}

function formatItems(items: BrowseItem[]): string {
  return items
    .filter((item) => item.hint !== "header")
    .map((item, i) => {
      const sub = item.subtitle ? ` - ${stripRoonLinks(item.subtitle)}` : "";
      return `${i + 1}. ${item.title}${sub}`;
    })
    .join("\n");
}

interface BrowseAndLoadResult {
  error: string | null;
  /** Whether the browse stack level changed (need to pop to go back) */
  navigated: boolean;
  list?: BrowseResult["list"];
  items?: BrowseItem[];
  message?: string;
}

/**
 * Helper: browse + load in one step.
 * Calls browse, then if action is "list", loads items.
 * Returns `navigated: true` if the browse stack changed (and you need pop_levels to go back).
 */
async function browseAndLoad(
  browse: RoonApiBrowse,
  browseOpts: BrowseOptions,
  loadCount = 100,
): Promise<BrowseAndLoadResult> {
  const result = await promisifyBrowse(browse, browseOpts);

  if (result.error) {
    return { error: String(result.error), navigated: false };
  }

  if (result.body.action === "message") {
    return { error: null, navigated: false, message: result.body.message || "Done" };
  }

  if (result.body.action !== "list" || !result.body.list) {
    return { error: null, navigated: false, list: result.body.list, items: [] };
  }

  // Browse succeeded with a list → we navigated deeper
  const loaded = await promisifyLoad(browse, {
    hierarchy: browseOpts.hierarchy,
    multi_session_key: browseOpts.multi_session_key,
    count: loadCount,
  });

  if (loaded.error) {
    return { error: String(loaded.error), navigated: true };
  }

  return { error: null, navigated: true, list: result.body.list, items: loaded.body.items };
}

/**
 * Find the best matching item from browse results.
 * Scores each item based on title + subtitle (artist) match against the query.
 * On equal scores, Roon's relevance ordering wins (first item).
 */
function bestMatch(items: BrowseItem[], query: string): BrowseItem | undefined {
  const playable = items.filter((item) => item.item_key && item.hint !== "header");
  if (!playable.length) return undefined;

  const lower = query.toLowerCase().trim();
  const queryWords = lower.split(/\s+/).filter((w) => w.length > 1);

  let topScore = -Infinity;
  let topItem = playable[0];

  for (let i = 0; i < playable.length; i++) {
    const item = playable[i];
    const titleLower = item.title.toLowerCase().trim();
    const subtitleLower = stripRoonLinks(item.subtitle || "").toLowerCase();
    let score = 0;

    // Word matching in title (high value)
    for (const word of queryWords) {
      if (titleLower.includes(word)) score += 10;
    }

    // Word matching in subtitle (artist disambiguation)
    for (const word of queryWords) {
      if (subtitleLower.includes(word)) score += 5;
    }

    // Primary artist bonus: first credited artist in subtitle is a strong
    // signal for the original version vs covers/remixes/tributes
    const firstArtist = subtitleLower.split(",")[0].trim();
    for (const word of queryWords) {
      if (word.length > 2 && firstArtist.includes(word)) score += 8;
    }

    // Penalty for tributes, covers, karaoke, medleys — these are almost never
    // what the user wants when searching for a specific artist/album/track
    if (/\b(tribute|cover[s]?|karaoke|medley|in the style of)\b/i.test(titleLower)) {
      score -= 50;
    }

    // Position bonus: Roon returns results in relevance order, so earlier
    // items are more likely to be what the user wants. This also breaks ties
    // in favor of Roon's ranking.
    score += Math.max(0, 5 - i);

    if (score > topScore) {
      topScore = score;
      topItem = item;
    }
  }

  return topItem;
}

/**
 * Find an action item (Play Now, Queue, etc.) from an action list.
 * Does NOT require hint === "action" — Roon may return actions with various hint values.
 */
function findAction(items: BrowseItem[], type: "play" | "queue"): BrowseItem | undefined {
  const actionable = items.filter((item) => item.item_key && item.hint !== "header");

  if (type === "play") {
    return (
      actionable.find((item) => item.title.trim().toLowerCase() === "play now") ||
      actionable.find((item) => item.title.trim().toLowerCase() === "play album") ||
      actionable.find(
        (item) =>
          item.title.toLowerCase().startsWith("play") &&
          !item.title.toLowerCase().includes("radio"),
      ) ||
      actionable[0]
    );
  }

  // queue: prefer Queue, then Play Album (sub-menu containing Queue), then Play Now
  return (
    actionable.find((item) => item.title.trim().toLowerCase() === "queue") ||
    actionable.find((item) => item.title.toLowerCase().includes("queue")) ||
    actionable.find((item) => item.title.trim().toLowerCase() === "play album") ||
    actionable.find(
      (item) =>
        item.title.toLowerCase().startsWith("play") &&
        !item.title.toLowerCase().includes("radio"),
    ) ||
    actionable.find((item) => item.title.trim().toLowerCase() === "play now") ||
    actionable[0]
  );
}

/**
 * Search for something and play/queue the best match.
 *
 * Flow through Roon browse hierarchy:
 * 1. Search → get categories (Artists, Albums, Tracks, Playlists...)
 * 2. Pick the matching category → get items in that category
 * 3. Pick the best matching item → get action list (Play Now, Queue, etc.)
 * 4. Pick the action → starts playback / queues
 * 5. Disable auto_radio to prevent radio mode after album/track ends
 *
 * All steps use the SAME multi_session_key to maintain browse state.
 */
async function searchAndPlay(
  query: string,
  zoneName: string,
  category?: string,
  actionType: "play" | "queue" = "play",
): Promise<ToolResult> {
  try {
    const browse = roonConnection.getBrowse();
    const zone = roonConnection.findZoneOrThrow(zoneName);
    const sessionKey = newSessionKey();
    const hierarchy = "search";
    const log = (step: string, data: unknown) =>
      console.error(`[roon-mcp] searchAndPlay[${sessionKey}] ${step}:`, JSON.stringify(data, null, 2));

    log("start", { query, zoneName: zone.display_name, zoneId: zone.zone_id, category, actionType });

    // Step 1: Start search
    const searchData = await browseAndLoad(browse, {
      hierarchy,
      input: query,
      pop_all: true,
      zone_or_output_id: zone.zone_id,
      multi_session_key: sessionKey,
    });

    log("step1-search", {
      error: searchData.error,
      navigated: searchData.navigated,
      itemCount: searchData.items?.length,
      items: searchData.items?.map((i) => ({ title: i.title, hint: i.hint, item_key: i.item_key })),
    });

    if (searchData.error) {
      return { content: [{ type: "text", text: `Search error: ${searchData.error}` }], isError: true };
    }

    if (!searchData.items?.length) {
      return { content: [{ type: "text", text: `No results found for "${query}".` }] };
    }

    // Step 2: Find the right category
    const categories = searchData.items;
    let targetCategory: BrowseItem | undefined;

    if (category) {
      const catLower = category.toLowerCase();
      // Try exact match first (e.g. "Artists", "Albums", "Tracks")
      targetCategory = categories.find(
        (item) =>
          item.item_key &&
          (item.title.toLowerCase() === catLower + "s" || item.title.toLowerCase() === catLower),
      );
      // Then try partial match
      if (!targetCategory) {
        targetCategory = categories.find(
          (item) =>
            item.item_key &&
            item.title.toLowerCase().includes(catLower) &&
            item.hint !== "header",
        );
      }
    }

    // Fallback: first selectable item
    if (!targetCategory) {
      targetCategory = categories.find((item) => item.item_key && item.hint !== "header");
    }

    log("step2-category", { selected: targetCategory?.title, hint: targetCategory?.hint, item_key: targetCategory?.item_key });

    if (!targetCategory?.item_key) {
      return {
        content: [{ type: "text", text: `Search results for "${query}":\n${formatItems(categories)}\n\nNo playable category found.` }],
      };
    }

    // Step 3: Drill into category to get items
    const categoryData = await browseAndLoad(browse, {
      hierarchy,
      item_key: targetCategory.item_key,
      zone_or_output_id: zone.zone_id,
      multi_session_key: sessionKey,
    });

    log("step3-categoryItems", {
      error: categoryData.error,
      navigated: categoryData.navigated,
      listTitle: categoryData.list?.title,
      listCount: categoryData.list?.count,
      itemCount: categoryData.items?.length,
      items: categoryData.items?.slice(0, 10).map((i) => ({ title: i.title, subtitle: i.subtitle, hint: i.hint, item_key: i.item_key })),
    });

    if (categoryData.error) {
      return { content: [{ type: "text", text: `Error browsing ${targetCategory.title}: ${categoryData.error}` }], isError: true };
    }

    if (!categoryData.items?.length) {
      return { content: [{ type: "text", text: `No ${targetCategory.title.toLowerCase()} found for "${query}".` }] };
    }

    // Step 4: Select best matching result (not just first)
    const matchedResult = bestMatch(categoryData.items, query);

    log("step4-bestMatch", { selected: matchedResult?.title, subtitle: matchedResult?.subtitle, hint: matchedResult?.hint, item_key: matchedResult?.item_key });

    if (!matchedResult?.item_key) {
      return {
        content: [{ type: "text", text: `${targetCategory.title} for "${query}":\n${formatItems(categoryData.items)}\n\nNo playable item found.` }],
      };
    }

    // Step 5: Select it to get action list
    const actionData = await browseAndLoad(browse, {
      hierarchy,
      item_key: matchedResult.item_key,
      zone_or_output_id: zone.zone_id,
      multi_session_key: sessionKey,
    });

    log("step5-actionList", {
      error: actionData.error,
      navigated: actionData.navigated,
      message: actionData.message,
      listTitle: actionData.list?.title,
      listHint: actionData.list?.hint,
      itemCount: actionData.items?.length,
      items: actionData.items?.map((i) => ({ title: i.title, hint: i.hint, item_key: i.item_key })),
    });

    // Some items might directly trigger playback (action = "message" or "none")
    if (actionData.message) {
      return {
        content: [{ type: "text", text: `${actionData.message} ("${matchedResult.title}" in zone '${zone.display_name}')` }],
      };
    }

    if (actionData.error) {
      return { content: [{ type: "text", text: `Error: ${actionData.error}` }], isError: true };
    }

    if (!actionData.items?.length) {
      return { content: [{ type: "text", text: `No actions available for "${matchedResult.title}".` }], isError: true };
    }

    // Step 5b: Navigate deeper if items are intermediate (hint: "action_list" or "list"),
    // not actual actions (hint: "action"). Roon may have multiple levels before the action list.
    //
    // Key distinction:
    // - Single intermediate item (e.g., a track in album context) → drill deeper to reach actions
    // - Multiple items (e.g., album tracklist, discography) → this IS the content, don't drill
    // - list.hint === "action_list" → items are the action list, don't drill
    let actionItems = actionData.items;
    let currentListHint = actionData.list?.hint;
    const MAX_NAV_DEPTH = 3;

    for (let depth = 0; depth < MAX_NAV_DEPTH; depth++) {
      // If the list itself is marked as an action list, items are actions
      if (currentListHint === "action_list") break;

      // If items include action-hinted items, we're at the action list
      const hasActions = actionItems.some((item) => item.hint === "action");
      if (hasActions) break;

      // Check if items are navigable (action_list or list hints that need drilling)
      const navigable = actionItems.filter(
        (item) => item.item_key && (item.hint === "action_list" || item.hint === "list"),
      );
      if (!navigable.length) break;

      // Multiple navigable items = content list (album tracklist, artist albums, etc.)
      // Don't drill into individual items — we'd lose the parent-level context.
      if (navigable.length > 1) {
        log(`step5-skip-drill`, { reason: "multiple navigable items (content list)", count: navigable.length });
        break;
      }

      // Single navigable item → likely an intermediate navigation level, go deeper
      const nextItem = navigable[0];

      log(`step5-deeper-${depth}`, { title: nextItem?.title, hint: nextItem?.hint, item_key: nextItem?.item_key });

      const deeper = await browseAndLoad(browse, {
        hierarchy,
        item_key: nextItem!.item_key!,
        zone_or_output_id: zone.zone_id,
        multi_session_key: sessionKey,
      });

      log(`step5-deeper-${depth}-result`, {
        error: deeper.error,
        navigated: deeper.navigated,
        message: deeper.message,
        listHint: deeper.list?.hint,
        itemCount: deeper.items?.length,
        items: deeper.items?.map((i) => ({ title: i.title, hint: i.hint, item_key: i.item_key })),
      });

      if (deeper.message) {
        // Action was triggered directly (e.g., playback started)
        return {
          content: [{ type: "text", text: `${deeper.message} ("${matchedResult.title}" in zone '${zone.display_name}')` }],
        };
      }

      if (deeper.error || !deeper.items?.length) break;
      actionItems = deeper.items;
      currentListHint = deeper.list?.hint;
    }

    // Step 6: Find and execute the right action (Play Now / Queue)
    const targetAction = findAction(actionItems, actionType);

    log("step6-action", { actionType, selected: targetAction?.title, hint: targetAction?.hint, item_key: targetAction?.item_key });

    if (!targetAction?.item_key) {
      return {
        content: [{ type: "text", text: `Available actions for "${matchedResult.title}":\n${formatItems(actionItems)}\n\nNo "${actionType}" action found.` }],
      };
    }

    // Step 7: Execute
    let playResult = await promisifyBrowse(browse, {
      hierarchy,
      item_key: targetAction.item_key,
      zone_or_output_id: zone.zone_id,
      multi_session_key: sessionKey,
    });

    log("step7-execute", {
      error: playResult.error,
      action: playResult.body.action,
      message: playResult.body.message,
      is_error: playResult.body.is_error,
      item: playResult.body.item,
      list: playResult.body.list,
    });

    if (playResult.error) {
      return { content: [{ type: "text", text: `Error: ${playResult.error}` }], isError: true };
    }

    // Step 7b: If the action opened a sub-menu (e.g., "Play Album" → Play Now/Queue/Start Radio),
    // load that sub-menu and find+execute the actual target action inside it.
    if (playResult.body.action === "list" && playResult.body.list) {
      const subItems = await promisifyLoad(browse, {
        hierarchy,
        multi_session_key: sessionKey,
        count: 20,
      });

      if (!subItems.error && subItems.body.items?.length) {
        log("step7-submenu", {
          listTitle: playResult.body.list.title,
          items: subItems.body.items.map((i) => ({ title: i.title, hint: i.hint, item_key: i.item_key })),
        });

        const subAction = findAction(subItems.body.items, actionType);
        if (subAction?.item_key) {
          log("step7-submenu-action", { selected: subAction.title, hint: subAction.hint });

          playResult = await promisifyBrowse(browse, {
            hierarchy,
            item_key: subAction.item_key,
            zone_or_output_id: zone.zone_id,
            multi_session_key: sessionKey,
          });

          log("step7-submenu-execute", {
            error: playResult.error,
            action: playResult.body.action,
            message: playResult.body.message,
          });

          if (playResult.error) {
            return { content: [{ type: "text", text: `Error: ${playResult.error}` }], isError: true };
          }
        }
      }
    }

    // Step 8: Disable auto_radio to prevent Roon Radio from taking over
    try {
      const transport = roonConnection.getTransport();
      await new Promise<void>((resolve) => {
        transport.change_settings(zone, { auto_radio: false }, () => resolve());
      });
    } catch {
      // Non-critical: if auto_radio disable fails, playback still works
    }

    const subtitle = matchedResult.subtitle ? ` by ${stripRoonLinks(matchedResult.subtitle)}` : "";
    const actionVerb = actionType === "queue" ? "Queued" : "Now playing";
    return {
      content: [{ type: "text", text: `${actionVerb}: "${matchedResult.title}"${subtitle} in zone '${zone.display_name}'.` }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
      isError: true,
    };
  }
}

export function registerBrowseTools(server: McpServer): void {
  server.tool(
    "search",
    "Search the Roon music library. Returns matching artists, albums, tracks, playlists, etc.",
    {
      query: z.string().describe("Search query (artist name, album title, track name, etc.)"),
      zone: z.string().optional().describe("Zone name or ID (optional, provides playback context)"),
    },
    async ({ query, zone }): Promise<ToolResult> => {
      try {
        const browse = roonConnection.getBrowse();
        const zoneObj = zone ? roonConnection.findZoneOrThrow(zone) : null;
        const sessionKey = newSessionKey();
        const hierarchy = "search";

        // Start search
        const searchData = await browseAndLoad(browse, {
          hierarchy,
          input: query,
          pop_all: true,
          zone_or_output_id: zoneObj?.zone_id,
          multi_session_key: sessionKey,
        });

        if (searchData.error) {
          return { content: [{ type: "text", text: `Search error: ${searchData.error}` }], isError: true };
        }

        if (!searchData.items?.length) {
          return { content: [{ type: "text", text: `No results for "${query}".` }] };
        }

        // For each category, drill in and show top results
        const allResults: string[] = [`Search results for "${query}":`];

        for (const cat of searchData.items) {
          if (!cat.item_key || cat.hint === "header") continue;

          const catData = await browseAndLoad(browse, {
            hierarchy,
            item_key: cat.item_key,
            zone_or_output_id: zoneObj?.zone_id,
            multi_session_key: sessionKey,
          }, 5);

          if (catData.error || !catData.items?.length) {
            if (catData.navigated) {
              await promisifyBrowse(browse, { hierarchy, pop_levels: 1, multi_session_key: sessionKey });
            }
            continue;
          }

          const count = catData.list?.count || catData.items.length;
          allResults.push(`\n${catData.list?.title || cat.title} (${count}):`);
          for (const item of catData.items) {
            if (item.hint === "header") continue;
            const sub = item.subtitle ? ` - ${stripRoonLinks(item.subtitle)}` : "";
            allResults.push(`  - ${item.title}${sub}`);
          }

          // Pop back to category list
          if (catData.navigated) {
            await promisifyBrowse(browse, { hierarchy, pop_levels: 1, multi_session_key: sessionKey });
          }
        }

        if (allResults.length <= 1) {
          return { content: [{ type: "text", text: `No results for "${query}".` }] };
        }

        if (zone) {
          allResults.push(`\nUse play_artist, play_album, play_playlist, or play_track to play a result.`);
        }

        return { content: [{ type: "text", text: allResults.join("\n") }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "play_artist",
    "Search for an artist and start playing their music in a Roon zone",
    {
      artist: z.string().describe("Artist name to search for"),
      zone: z.string().describe("Zone name or ID to play in"),
    },
    async ({ artist, zone }) => searchAndPlay(artist, zone, "artist"),
  );

  server.tool(
    "play_album",
    "Search for an album and start playing it in a Roon zone",
    {
      album: z.string().describe("Album name to search for"),
      zone: z.string().describe("Zone name or ID to play in"),
    },
    async ({ album, zone }) => searchAndPlay(album, zone, "album"),
  );

  server.tool(
    "play_playlist",
    "Search for a playlist and start playing it in a Roon zone",
    {
      playlist: z.string().describe("Playlist name to search for"),
      zone: z.string().describe("Zone name or ID to play in"),
    },
    async ({ playlist, zone }) => searchAndPlay(playlist, zone, "playlist"),
  );

  server.tool(
    "play_track",
    "Search for a specific track/song and start playing it in a Roon zone",
    {
      track: z.string().describe("Track/song name to search for"),
      zone: z.string().describe("Zone name or ID to play in"),
    },
    async ({ track, zone }) => searchAndPlay(track, zone, "track"),
  );

  server.tool(
    "add_to_queue",
    "Search for a track, album, artist, or playlist and add it to the queue in a Roon zone",
    {
      query: z.string().describe("Search query (track name, album title, artist name, etc.)"),
      zone: z.string().describe("Zone name or ID to queue in"),
      category: z
        .enum(["track", "album", "artist", "playlist"])
        .optional()
        .describe("Category to search in (optional, auto-detects if not specified)"),
    },
    async ({ query, zone, category }) => searchAndPlay(query, zone, category, "queue"),
  );
}
