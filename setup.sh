#!/bin/bash

# Check if Node.js is installed and version is 18+
if ! command -v node &> /dev/null
then
    echo "Node.js is not installed. Please install it from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo ""
    echo "ERROR: Your Node.js version is too old (v$NODE_VERSION)."
    echo "Vite 6 requires Node.js 18.0.0 or higher."
    echo "Please update Node.js at https://nodejs.org/"
    echo ""
    exit 1
fi

echo "--- BOM Viewer Setup ---"
echo "1. Fixing npm registry (Taobao registry has expired)..."
npm config set registry https://registry.npmjs.org/

echo "2. Installing dependencies..."
npm install

echo "2. Starting development server..."
npm run dev
