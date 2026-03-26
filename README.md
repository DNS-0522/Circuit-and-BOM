# BOM & PDF Viewer

A professional tool for comparing Bill of Materials (BOM) data and visualizing component locations on PDF schematics.

## Features
- **PDF Visualization**: Automatically find and highlight components on PDF pages.
- **BOM Comparison**: Compare two BOM files and highlight added, removed, or modified components.
- **Status Tracking**: Mark components as "Confirmed" or "Doubtful" to track progress.
- **Dark Mode Support**: Comfortable viewing in any lighting condition.

## Local Setup

### Prerequisites
- [Node.js](https://nodejs.org/) **(v18.0.0 or higher required)**
- npm (comes with Node.js)

### Quick Start

#### Windows
Double-click `setup.bat`.

#### macOS / Linux
Run the following in your terminal:
```bash
chmod +x setup.sh
./setup.sh
```

### Manual Installation
1. Install dependencies: `npm install`
2. Start the development server: `npm run dev`
3. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Built With
- **React 19**
- **Vite**
- **PDF.js**
- **Tailwind CSS**
- **Lucide Icons**
