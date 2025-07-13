import { AppServer, AppSession, ViewType, AuthenticatedRequest, PhotoData } from '@mentra/sdk';
import { Request, Response } from 'express';
import * as ejs from 'ejs';
import * as path from 'path';
import * as fs from 'fs/promises';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * Interface representing a stored photo with metadata
 */
interface StoredPhoto {
  requestId: string;
  buffer: Buffer;
  timestamp: Date;
  userId: string;
  mimeType: string;
  filename: string;
  size: number;
}

/**
 * Streaming modes for different capture rates
 */
enum StreamingMode {
  OFF = 'off',
  PHOTO_SLOW = 'photo_slow',    // 1 photo every 2 seconds
  PHOTO_FAST = 'photo_fast'     // 2 photos per second
}


const PACKAGE_NAME = process.env.PACKAGE_NAME ?? (() => { throw new Error('PACKAGE_NAME is not set in .env file'); })();
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY ?? (() => { throw new Error('MENTRAOS_API_KEY is not set in .env file'); })();
const PORT = parseInt(process.env.PORT || '3000');

/**
 * Photo Taker App with webview functionality for displaying photos
 * Extends AppServer to provide photo taking and webview display capabilities
 */
class ExampleMentraOSApp extends AppServer {
  private photos: Map<string, StoredPhoto> = new Map(); // Store photos by userId
  private latestPhotoTimestamp: Map<string, number> = new Map(); // Track latest photo timestamp per user
  private isStreamingPhotos: Map<string, boolean> = new Map(); // Track if we are streaming photos for a user
  private nextPhotoTime: Map<string, number> = new Map(); // Track next photo time for a user
  private activeRequests: Map<string, boolean> = new Map(); // Track active requests per user
  
  // WebSocket streaming properties
  private wss: WebSocketServer;
  private activeStreams: Map<string, WebSocket[]> = new Map(); // WebSocket clients per user
  private streamingMode: Map<string, StreamingMode> = new Map(); // Current streaming mode per user

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: MENTRAOS_API_KEY,
      port: PORT,
    });
    this.setupWebviewRoutes();
    this.setupWebSocketServer();
  }

  /**
   * Setup WebSocket server for real-time streaming
   */
  private setupWebSocketServer(): void {
    this.wss = new WebSocketServer({ port: 8080 });
    
    this.wss.on('connection', (ws: WebSocket, req) => {
      this.logger.info('New WebSocket connection established');
      
      // For now, add to a general stream (we'll improve this later with user-specific streams)
      if (!this.activeStreams.has('general')) {
        this.activeStreams.set('general', []);
      }
      this.activeStreams.get('general')!.push(ws);
      
      ws.on('close', () => {
        this.logger.info('WebSocket connection closed');
        this.removeWebSocket('general', ws);
      });
      
      ws.on('error', (error) => {
        this.logger.error(`WebSocket error: ${error}`);
        this.removeWebSocket('general', ws);
      });
    });
    
    this.logger.info('WebSocket server started on port 8080');
  }

  /**
   * Remove a WebSocket from active streams
   */
  private removeWebSocket(streamId: string, ws: WebSocket): void {
    const clients = this.activeStreams.get(streamId);
    if (clients) {
      const index = clients.indexOf(ws);
      if (index > -1) {
        clients.splice(index, 1);
      }
    }
  }

  /**
   * Broadcast photo to all connected WebSocket clients
   */
  private broadcastPhoto(photo: StoredPhoto): void {
    const clients = this.activeStreams.get('general') || [];
    const base64Data = photo.buffer.toString('base64');
    
    const message = JSON.stringify({
      type: 'photo',
      data: base64Data,
      mimeType: photo.mimeType,
      timestamp: photo.timestamp.getTime(),
      size: photo.size
    });
    
    clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch (error) {
          this.logger.error(`Error sending WebSocket message: ${error}`);
          this.removeWebSocket('general', ws);
        }
      }
    });
    
    this.logger.debug(`Broadcasted photo to ${clients.length} WebSocket clients`);
  }

  /**
   * Take a photo asynchronously without blocking
   */
  private async takePhotoAsync(userId: string, session: AppSession): Promise<void> {
    try {
      this.logger.debug(`Taking photo for user ${userId}`);
      const photo = await session.camera.requestPhoto();
      
      this.logger.info(`Photo completed for user ${userId}`);
      this.cachePhoto(photo, userId);
      
    } catch (error) {
      // Check for WebSocket disconnection
      if (error.message && (error.message.includes('WebSocket not connected') || error.message.includes('CLOSED'))) {
        this.logger.warn(`WebSocket disconnected for user ${userId}, stopping streaming`);
        // Stop streaming when WebSocket disconnects
        this.isStreamingPhotos.set(userId, false);
      } else {
        this.logger.error(`Photo request failed for user ${userId}: ${error}`);
      }
    } finally {
      // Always clear the active request flag
      this.activeRequests.set(userId, false);
    }
  }


  /**
   * Handle new session creation and button press events
   */
  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    // this gets called whenever a user launches the app
    this.logger.info(`Session started for user ${userId}`);

    // set the initial state of the user
    this.isStreamingPhotos.set(userId, false);
    this.nextPhotoTime.set(userId, Date.now());

    // this gets called whenever a user presses a button
    session.events.onButtonPress(async (button) => {
      this.logger.info(`Button pressed: ${button.buttonId}, type: ${button.pressType}`);

      if (button.pressType === 'long') {
        // the user held the button, so we toggle the streaming mode
        this.isStreamingPhotos.set(userId, !this.isStreamingPhotos.get(userId));
        this.logger.info(`Streaming photos for user ${userId} is now ${this.isStreamingPhotos.get(userId)}`);
        return;
      } else {
        session.layouts.showTextWall("Button pressed, about to take photo", {durationMs: 4000});
        // the user pressed the button, so we take a single photo
        if (!this.activeRequests.get(userId)) {
          this.activeRequests.set(userId, true);
          this.logger.info(`Starting manual photo request for user ${userId}`);
          this.takePhotoAsync(userId, session);
        } else {
          this.logger.warn(`Manual photo request skipped for user ${userId} - request already in progress`);
        }
      }
    });

    // repeatedly check if we are in streaming mode and if we are ready to take another photo
    setInterval(async () => {
      if (this.isStreamingPhotos.get(userId) && Date.now() > (this.nextPhotoTime.get(userId) ?? 0)) {
        try {
          // set the next photo for 2 seconds from now (photo streaming rate, not video rate)
          this.nextPhotoTime.set(userId, Date.now() + 2000);

          // Check if no request is in progress, then start one
          if (!this.activeRequests.get(userId)) {
            this.activeRequests.set(userId, true);
            
            // Start photo request asynchronously without blocking streaming
            this.takePhotoAsync(userId, session);
          }
        } catch (error) {
          this.logger.error(`Error auto-taking photo: ${error}`);
        }
      }
    }, 1000);
  }

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    // clean up the user's state
    this.isStreamingPhotos.set(userId, false);
    this.nextPhotoTime.delete(userId);
    this.activeRequests.delete(userId);
    
    this.logger.info(`Session stopped for user ${userId}, reason: ${reason}`);
  }

  /**
   * Cache a photo for display
   */
  private async cachePhoto(photo: PhotoData, userId: string) {
    // create a new stored photo object which includes the photo data and the user id
    const cachedPhoto: StoredPhoto = {
      requestId: photo.requestId,
      buffer: photo.buffer,
      timestamp: photo.timestamp,
      userId: userId,
      mimeType: photo.mimeType,
      filename: photo.filename,
      size: photo.size
    };

    // this example app simply stores the photo in memory for display in the webview, but you could also send the photo to an AI api,
    // or store it in a database or cloud storage, send it to roboflow, or do other processing here

    // cache the photo for display
    this.photos.set(userId, cachedPhoto);
    // update the latest photo timestamp
    this.latestPhotoTimestamp.set(userId, cachedPhoto.timestamp.getTime());
    this.logger.info(`Photo cached for user ${userId}, timestamp: ${cachedPhoto.timestamp}`);
    
    // Broadcast photo to WebSocket clients for real-time streaming
    this.broadcastPhoto(cachedPhoto);
    
    // Save the photo to the current folder
    try {
      // Create photos directory if it doesn't exist
      const photosDir = path.join(process.cwd(), 'photos');
      await fs.mkdir(photosDir, { recursive: true });
      
      // Create a unique filename based on user ID and timestamp
      const fileExt = cachedPhoto.mimeType.split('/')[1] || 'jpg';
      const timestamp = cachedPhoto.timestamp.getTime();
      const filename = path.join(photosDir, `photo_${userId}_${timestamp}.${fileExt}`);
      
      // Write the photo buffer to the file
      await fs.writeFile(filename, cachedPhoto.buffer);
      this.logger.info(`Photo saved to disk at: ${filename}`);
    } catch (error) {
      this.logger.error(`Error saving photo to disk: ${error}`);
    }
  }


  /**
 * Set up webview routes for photo display functionality
 */
  private setupWebviewRoutes(): void {
    const app = this.getExpressApp();

    // API endpoint to get the latest photo for the authenticated user
    app.get('/api/latest-photo', (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;

      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const photo = this.photos.get(userId);
      if (!photo) {
        res.status(404).json({ error: 'No photo available' });
        return;
      }

      res.json({
        requestId: photo.requestId,
        timestamp: photo.timestamp.getTime(),
        hasPhoto: true,
        isStreaming: this.isStreamingPhotos.get(userId) || false
      });
    });

    // API endpoint to get photo data
    app.get('/api/photo/:requestId', (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;
      const requestId = req.params.requestId;

      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const photo = this.photos.get(userId);
      if (!photo || photo.requestId !== requestId) {
        res.status(404).json({ error: 'Photo not found' });
        return;
      }

      res.set({
        'Content-Type': photo.mimeType,
        'Cache-Control': 'no-cache'
      });
      res.send(photo.buffer);
    });

    // Main webview route - displays the photo viewer interface
    app.get('/webview', async (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;

      if (!userId) {
        res.status(401).send(`
          <html>
            <head><title>Photo Viewer - Not Authenticated</title></head>
            <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
              <h1>Please open this page from the MentraOS app</h1>
            </body>
          </html>
        `);
        return;
      }

      const templatePath = path.join(process.cwd(), 'views', 'photo-viewer.ejs');
      const html = await ejs.renderFile(templatePath, {});
      res.send(html);
    });

    // Root route - displays the latest captured image
    app.get('/', (req: any, res: any) => {
      // Get the most recent photo from all users
      let latestPhoto: StoredPhoto | null = null;
      let latestTimestamp = 0;

      for (const [userId, photo] of this.photos.entries()) {
        const photoTimestamp = photo.timestamp.getTime();
        if (photoTimestamp > latestTimestamp) {
          latestTimestamp = photoTimestamp;
          latestPhoto = photo;
        }
      }

      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Glass Camera Stream</title>
          <style>
            body {
              margin: 0;
              padding: 20px;
              background-color: #000;
              color: white;
              font-family: Arial, sans-serif;
              text-align: center;
            }
            .container {
              max-width: 100vw;
              max-height: 100vh;
            }
            .image-container {
              margin: 20px 0;
            }
            .latest-image {
              max-width: 90vw;
              max-height: 80vh;
              object-fit: contain;
              border-radius: 8px;
              border: 2px solid #333;
            }
            .info {
              margin: 10px 0;
              padding: 10px;
              background-color: rgba(255, 255, 255, 0.1);
              border-radius: 5px;
              display: inline-block;
            }
            .no-image {
              color: #888;
              font-size: 18px;
              margin: 50px 0;
            }
            .stream-controls {
              margin: 20px 0;
              display: flex;
              gap: 10px;
              justify-content: center;
              flex-wrap: wrap;
            }
            .mode-btn {
              background-color: #333;
              color: white;
              border: none;
              padding: 10px 20px;
              border-radius: 5px;
              cursor: pointer;
              font-size: 14px;
              transition: background-color 0.3s;
            }
            .mode-btn:hover {
              background-color: #555;
            }
            .mode-btn.active {
              background-color: #28a745;
            }
            .stream-info {
              margin: 20px 0;
              padding: 15px;
              background-color: rgba(255, 255, 255, 0.1);
              border-radius: 8px;
              display: inline-block;
              text-align: left;
            }
            .stream-info > div {
              margin: 5px 0;
              font-size: 14px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🥽 Glass Camera Stream</h1>
            
            <div class="stream-controls">
              <button id="mode-off" class="mode-btn">Stop</button>
              <button id="mode-slow" class="mode-btn">Slow (0.5 FPS)</button>
              <button id="mode-fast" class="mode-btn">Fast (2 FPS)</button>
            </div>
            
            <div class="stream-info">
              <div>Mode: <span id="current-mode">Off</span></div>
              <div>FPS: <span id="current-fps">0</span></div>
              <div>Last Update: <span id="last-update">Never</span></div>
              <div>Connection: <span id="connection-status">Connecting...</span></div>
            </div>
            
            <div class="image-container">
              ${latestPhoto ? `
                <img id="stream-image" class="latest-image" src="data:${latestPhoto.mimeType};base64,${latestPhoto.buffer.toString('base64')}" alt="Live stream" />
              ` : `
                <div id="no-image" class="no-image">
                  No images captured yet.<br>
                  Connect your Glass device and take a photo!
                </div>
              `}
            </div>
          </div>
          
          <script>
            // WebSocket connection for real-time streaming
            const ws = new WebSocket('ws://localhost:8080');
            let frameCount = 0;
            let lastFpsUpdate = Date.now();
            
            ws.onopen = () => {
              document.getElementById('connection-status').textContent = 'Connected';
              document.getElementById('connection-status').style.color = '#28a745';
            };
            
            ws.onclose = () => {
              document.getElementById('connection-status').textContent = 'Disconnected';
              document.getElementById('connection-status').style.color = '#dc3545';
            };
            
            ws.onerror = () => {
              document.getElementById('connection-status').textContent = 'Error';
              document.getElementById('connection-status').style.color = '#dc3545';
            };
            
            ws.onmessage = (event) => {
              const data = JSON.parse(event.data);
              
              if (data.type === 'photo') {
                // Hide no-image message and show image
                const noImageDiv = document.getElementById('no-image');
                if (noImageDiv) noImageDiv.style.display = 'none';
                
                // Update or create image element
                let imgElement = document.getElementById('stream-image');
                if (!imgElement) {
                  imgElement = document.createElement('img');
                  imgElement.id = 'stream-image';
                  imgElement.className = 'latest-image';
                  imgElement.alt = 'Live stream';
                  document.querySelector('.image-container').appendChild(imgElement);
                }
                
                imgElement.src = 'data:' + data.mimeType + ';base64,' + data.data;
                
                // Update FPS counter
                frameCount++;
                const now = Date.now();
                if (now - lastFpsUpdate >= 1000) {
                  document.getElementById('current-fps').textContent = frameCount.toFixed(1);
                  frameCount = 0;
                  lastFpsUpdate = now;
                }
                
                document.getElementById('last-update').textContent = 
                  new Date(data.timestamp).toLocaleTimeString();
              }
            };
            
            // Mode control buttons (placeholder for now)
            document.getElementById('mode-off').addEventListener('click', () => {
              document.getElementById('current-mode').textContent = 'Off';
              // TODO: Implement mode switching
            });
            
            document.getElementById('mode-slow').addEventListener('click', () => {
              document.getElementById('current-mode').textContent = 'Slow';
              // TODO: Implement mode switching
            });
            
            document.getElementById('mode-fast').addEventListener('click', () => {
              document.getElementById('current-mode').textContent = 'Fast';
              // TODO: Implement mode switching
            });
          </script>
        </body>
        </html>
      `;

      res.send(html);
    });

    // API endpoint to toggle streaming mode
    app.post('/api/toggle-streaming', (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;

      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const currentState = this.isStreamingPhotos.get(userId) || false;
      this.isStreamingPhotos.set(userId, !currentState);
      
      this.logger.info(`Streaming toggled for user ${userId}: ${!currentState}`);
      
      res.json({
        isStreaming: !currentState,
        message: !currentState ? 'Streaming started' : 'Streaming stopped'
      });
    });
  }
}



// Start the server
// DEV CONSOLE URL: https://console.mentra.glass/
// Get your webhook URL from ngrok (or whatever public URL you have)
const app = new ExampleMentraOSApp();

app.start().catch(console.error);