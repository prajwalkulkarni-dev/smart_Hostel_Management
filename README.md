# SmartMess - Food Subscription System

A modern, responsive food subscription system for messes and canteens. Built with Node.js, Express, and MongoDB Atlas.

## Features

- 🌓 **Dark Mode**: Sleek dark and light themes with system preference detection.
- 🍱 **Subscription Plans**: Multiple meal plans (Breakfast, Lunch, Dinner, Full Day).
- 📋 **Student Portal**: Dashboard to view subscription details and mark daily attendance.
- 💾 **Dual Storage**: Automatically falls back to a local JSON file if MongoDB Atlas is unavailable.
- 🔒 **Secure**: Environment variable configuration and protected server files.

## Prerequisites

- [Node.js](https://nodejs.org/) installed.
- (Optional) A [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) account and connection string.

## Setup

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment**:
   - Rename `.env.example` to `.env`.
   - Update `MONGODB_URI` with your connection string if using Atlas.
   - (Optional) Change `PORT` (defaults to 3000).

3. **Start the Server**:
   ```bash
   npm start
   ```

4. **Access the App**:
   Open `http://localhost:3000` (or your custom port) in your browser.

## Security Note

The project uses a `public/` directory for static assets. This ensures that sensitive files like `server.js`, `.env`, and your data files are NOT accessible via the browser.

## License

MIT
