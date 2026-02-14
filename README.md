# Roon MCP Server

An MCP (Model Context Protocol) server that lets Claude Desktop control [Roon](https://roon.app/) music playback. Search your library, play music, control volume, and manage zones — all through natural language.

## Features

- **19 MCP tools** for full Roon control
- Search and play artists, albums, tracks, and playlists
- Playback controls: play, pause, stop, skip, seek, shuffle, loop
- Volume control with mute support
- Zone management and now-playing info
- Queue management (add tracks, albums, playlists)
- Direct WebSocket connection to Roon Core (no discovery needed)
- Auto-reconnect on connection loss
- Persistent pairing (only authorize once in Roon)

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- A [Roon](https://roon.app/) Core running on your network
- [Claude Desktop](https://claude.ai/download)

## Installation

```bash
git clone https://github.com/AzureStackNerd/roon-mcp.git
cd roon-mcp
npm install
npm run build
```

## Configuration

Add the server to your Claude Desktop configuration file:

- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "roon": {
      "command": "node",
      "args": ["C:\\path\\to\\roon-mcp\\build\\index.js"],
      "env": {
        "ROON_HOST": "192.168.1.100",
        "ROON_PORT": "9330"
      }
    }
  }
}
```

### Environment Variables

| Variable    | Default         | Description                      |
| ----------- | --------------- | -------------------------------- |
| `ROON_HOST` | `192.168.1.100` | IP address of your Roon Core     |
| `ROON_PORT` | `9100`          | WebSocket port of your Roon Core |

> **Finding your Roon Core port**: In Roon, go to **Settings > General** and look for the HTTP port displayed under your Core name. The default is 9100, but it may differ.

## First-Time Setup

1. Start Claude Desktop with the MCP server configured
2. In Roon, go to **Settings > Extensions**
3. Find **Roon MCP for Claude** and click **Enable**
4. The extension will remember its authorization for future restarts

## Available Tools

### Zone & Status

| Tool          | Parameters | Description                                              |
| ------------- | ---------- | -------------------------------------------------------- |
| `list_zones`  | —          | List all zones with current playback status              |
| `now_playing` | `zone?`    | Get current track info for a zone (or all playing zones) |

### Playback Controls

| Tool             | Parameters                     | Description                                            |
| ---------------- | ------------------------------ | ------------------------------------------------------ |
| `play`           | `zone`                         | Start playback                                         |
| `pause`          | `zone`                         | Pause playback                                         |
| `play_pause`     | `zone`                         | Toggle play/pause                                      |
| `stop`           | `zone`                         | Stop playback and release audio device                 |
| `next_track`     | `zone`                         | Skip to next track                                     |
| `previous_track` | `zone`                         | Go to previous track                                   |
| `seek`           | `zone`, `seconds`, `relative?` | Seek to position (absolute or relative)                |
| `shuffle`        | `zone`, `enabled`              | Enable or disable shuffle                              |
| `loop`           | `zone`, `mode`                 | Set loop mode (`loop`, `loop_one`, `disabled`, `next`) |

### Volume

| Tool            | Parameters              | Description                                             |
| --------------- | ----------------------- | ------------------------------------------------------- |
| `change_volume` | `zone`, `value`, `how?` | Change volume (`absolute`, `relative`, `relative_step`) |
| `mute`          | `zone`, `mute`          | Mute or unmute                                          |
| `get_volume`    | `zone`                  | Get current volume level and mute status                |

### Search & Play

| Tool            | Parameters                   | Description                                                     |
| --------------- | ---------------------------- | --------------------------------------------------------------- |
| `search`        | `query`, `zone?`             | Search the library (returns artists, albums, tracks, playlists) |
| `play_artist`   | `artist`, `zone`             | Search and play an artist                                       |
| `play_album`    | `album`, `zone`              | Search and play an album                                        |
| `play_playlist` | `playlist`, `zone`           | Search and play a playlist                                      |
| `play_track`    | `track`, `zone`              | Search and play a specific track                                |
| `add_to_queue`  | `query`, `zone`, `category?` | Search and add to the queue                                     |

## Usage Examples

Once configured, you can ask Claude things like:

- _"What zones are available?"_
- _"What's playing right now?"_
- _"Play Blue by Joni Mitchell in the living room"_
- _"Play the album Bad by Michael Jackson in Bedroom"_
- _"Skip to the next track"_
- _"Turn the volume down a bit in the kitchen"_
- _"Add Bohemian Rhapsody to the queue"_
- _"Enable shuffle mode"_
- _"Search for Miles Davis"_

## Architecture

```text
src/
  index.ts              # Entry point, MCP server setup
  roon-connection.ts    # Roon connection management, zone cache
  tools/
    zone.ts             # list_zones, now_playing
    playback.ts         # play, pause, stop, seek, shuffle, loop
    volume.ts           # change_volume, mute, get_volume
    browse.ts           # search, play_artist/album/playlist/track, add_to_queue
types/
  node-roon-api.d.ts            # Type declarations for node-roon-api
  node-roon-api-transport.d.ts  # Type declarations for node-roon-api-transport
  node-roon-api-browse.d.ts     # Type declarations for node-roon-api-browse
  node-roon-api-status.d.ts     # Type declarations for node-roon-api-status
```

## Development

```bash
# Build
npm run build

# Run directly
npm start

# Test interactively with MCP Inspector
npx @modelcontextprotocol/inspector node build/index.js
```

## Troubleshooting

### "Not connected to Roon"

- Verify `ROON_HOST` and `ROON_PORT` point to your Roon Core
- Check that the extension is enabled in Roon > Settings > Extensions

### Extension requires re-enabling after every restart

- The pairing token is stored in `roon-mcp/config.json`. After the first authorization it should persist across restarts. If you still need to re-enable, check that the `config.json` file exists in the project root after the first pairing.

### Search finds wrong version of a track/album

- Include the artist name in your query for better matching, e.g. _"Dirty Diana Michael Jackson"_ instead of just _"Dirty Diana"_

### Playback doesn't start after search

- Check the Roon Core logs for errors
- Ensure the zone is available and not in use by another controller

## License

MIT
