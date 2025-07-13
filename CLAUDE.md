# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a MentraOS Glass camera streaming application that enables real-time photo capture and WebSocket-based live streaming from Glass devices. The app provides both authenticated webviews for Glass users and a public dashboard for real-time viewing.

## Development Commands

### Core Commands
```bash
# Install dependencies
bun install

# Development server with hot reload
bun run dev

# Production server
bun run start
```

### Server Information
- **Express Server**: Port 3000 (HTTP endpoints, webviews)
- **WebSocket Server**: Port 8080 (Real-time streaming)
- **Runtime**: Bun (handles TypeScript natively, no build step needed)

### Environment Setup
Required environment variables in `.env`:
```bash
PORT=3000
PACKAGE_NAME=com.collab.glass
MENTRAOS_API_KEY=your_api_key_from_console.mentra.glass
```

## Architecture Overview

### Core Application Structure
The main application (`src/index.ts`) extends MentraOS `AppServer` and implements a dual-server architecture:

1. **ExampleMentraOSApp Class** - Main application controller
2. **Express Server** - HTTP endpoints and EJS template serving
3. **WebSocket Server** - Real-time photo broadcasting

### Key Components

#### MentraOS Integration
- **Device Events**: Button press handling (short=photo, long=toggle streaming)
- **Camera API**: `session.camera.requestPhoto()` for photo capture
- **Authentication**: Uses `AuthenticatedRequest` with `authUserId` for webviews
- **User Feedback**: `session.layouts.showTextWall()` for device notifications

#### Streaming System
```typescript
enum StreamingMode {
  OFF = 'off',
  PHOTO_SLOW = 'photo_slow',    // 0.5 FPS
  PHOTO_FAST = 'photo_fast',    // 2 FPS  
  VIDEO_PREVIEW = 'video_preview' // 5 FPS
}
```

Real-time streaming flow:
1. Glass device captures photo → 2. Cache in memory + save to disk → 3. Broadcast via WebSocket → 4. Live update in web interface

#### Data Management
- **Photo Storage**: In-memory Map + file system persistence (`/photos/` directory)
- **User State**: Per-user Maps for streaming status, active requests, timing
- **WebSocket Clients**: Connection management with automatic cleanup

### API Endpoints

#### Public Routes
- `GET /` - Live streaming dashboard with WebSocket connection
- `GET /api/latest-photo` - Latest photo metadata (unauthenticated)

#### Authenticated Routes (MentraOS users)
- `GET /webview` - Photo viewer interface for Glass users
- `POST /api/toggle-streaming` - Control streaming mode
- `GET /api/photo/:requestId` - Photo data retrieval

### Real-time Features

#### WebSocket Implementation
- **Port 8080** for WebSocket server
- **Broadcast Schema**:
  ```json
  {
    "type": "photo",
    "data": "base64_image_data", 
    "mimeType": "image/jpeg",
    "timestamp": 1234567890,
    "size": 12345
  }
  ```

#### Frontend Integration
- **Live FPS Counter** - Real-time frame rate monitoring
- **Connection Status** - WebSocket health indicator
- **Auto-updates** - No page refresh needed for new photos

### Error Handling
- **WebSocket Disconnection**: Automatic streaming stop when device disconnects
- **Request Timeout**: 10-second timeout with graceful fallback
- **Duplicate Prevention**: Active request tracking prevents concurrent photo requests

### Development Workflow

1. **Setup ngrok** for public URL exposure (required for MentraOS device communication)
2. **Register app** on console.mentra.glass with ngrok URL
3. **Configure environment** variables
4. **Run development server** with `bun run dev`
5. **Access interfaces**:
   - Public dashboard: `http://localhost:3000`
   - WebSocket endpoint: `ws://localhost:8080`
   - Authenticated webview: `/webview` (through MentraOS app)

### Important Implementation Details

#### Photo Capture Flow
- **Async Processing**: Non-blocking photo capture prevents streaming interruption
- **State Management**: Per-user active request flags prevent race conditions
- **Cleanup**: Automatic state cleanup on session disconnect

#### Container Deployment
- **Bun-based Dockerfile** with multi-stage build
- **Porter.yaml** for cloud deployment configuration
- **Port Configuration**: Exposes both HTTP (3000) and WebSocket (8080) ports

The application effectively bridges MentraOS Glass hardware with modern web-based real-time viewing through a clean WebSocket architecture.