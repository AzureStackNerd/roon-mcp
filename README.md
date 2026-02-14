# roon-mcp

MCP server for controlling Roon music playback via Claude Desktop.

## Setup

```bash
npm install
npm run build
```

## Claude Desktop Configuration

Add to your `claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "roon": {
      "command": "node",
      "args": ["C:\\path\\to\\roon-mcp\\build\\index.js"],
      "env": {
        "ROON_HOST": "192.168.1.100",
        "ROON_PORT": "9100"
      }
    }
  }
}
```

Replace `ROON_HOST` with the IP address of your Roon Core.

## First Use

1. Start Claude Desktop (restart if already running)
2. Open Roon, go to **Settings > Extensions**
3. Find "Roon MCP for Claude" and click **Enable**
4. Ask Claude: "What zones do I have?" or "Play music in the living room"

## Available Tools

| Tool | Description |
| ---- | ----------- |
| `list_zones` | List all zones with playback status |
| `now_playing` | Get current track info |
| `play` | Start playback |
| `pause` | Pause playback |
| `play_pause` | Toggle play/pause |
| `stop` | Stop playback |
| `next_track` | Skip to next track |
| `previous_track` | Go to previous track |

## Environment Variables

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `ROON_HOST` | `192.168.1.100` | IP address of Roon Core |
| `ROON_PORT` | `9100` | WebSocket port of Roon Core |
