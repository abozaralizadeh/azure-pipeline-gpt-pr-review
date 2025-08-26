#!/bin/bash

# Advanced Azure DevOps PR Reviewer - Build Script
# This script helps build and test the extension

set -e

echo "🚀 Building Advanced Azure DevOps PR Reviewer..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 18+ is required. Current version: $(node -v)"
    exit 1
fi

echo "✅ Node.js version: $(node -v)"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Run tests
echo "🧪 Running tests..."
npm test

# Build the project
echo "🔨 Building TypeScript..."
npm run build

# Check if build was successful
if [ -d "GenAIAdvancedPRReviewer/dist" ]; then
    echo "✅ Build completed successfully!"
    echo "📁 Output directory: dist/"
    echo "📊 Build summary:"
    echo "   - Main entry point: dist/index.js"
    echo "   - TypeScript declarations: dist/*.d.ts"
    echo "   - Source maps: dist/*.js.map"
else
    echo "❌ Build failed!"
    exit 1
fi

# Optional: Run in development mode
if [ "$1" = "--dev" ]; then
    echo "🔄 Starting development mode..."
    npm run dev
fi

echo "🎉 Build process completed!"
echo ""
echo "Next steps:"
echo "1. Test the extension in Azure DevOps"
echo "2. Configure your Azure OpenAI endpoint"
echo "3. Set up pipeline variables"
echo "4. Monitor LLM usage and costs"
echo ""
echo "For more information, see README.md and overview.md"
