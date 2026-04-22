#!/bin/bash
# ============================================
# NexCrawl / NexCrawl Linux Installer
# ============================================

set -e

echo ""
echo "========================================"
echo "  NexCrawl Linux Installation Script"
echo "========================================"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed."
    echo ""
    echo "Please install Node.js (v20 or higher):"
    echo ""
    echo "  Ubuntu/Debian:"
    echo "    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "    sudo apt-get install -y nodejs"
    echo ""
    echo "  CentOS/RHEL:"
    echo "    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -"
    echo "    sudo yum install -y nodejs"
    echo ""
    echo "  Arch Linux:"
    echo "    sudo pacman -S nodejs npm"
    echo ""
    echo "  Or use nvm:"
    echo "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
    echo "    nvm install 20"
    echo ""
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v)
echo "[INFO] Node.js version: $NODE_VERSION"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "[ERROR] npm is not installed."
    exit 1
fi

# Check if running on Linux
if [[ "$(uname)" == "Linux" ]]; then
    echo "[INFO] Detected Linux system: $(uname -m)"
else
    echo "[WARNING] This script is designed for Linux, but you're running on $(uname)"
    echo "[INFO] Continuing anyway..."
fi

echo ""
echo "[INFO] Installing dependencies..."
npm install

echo ""
echo "[INFO] Installation completed successfully!"
echo ""
echo "========================================"
echo "  Next Steps:"
echo "========================================"
echo ""
echo "1. Start the server:"
echo "   npm start"
echo ""
echo "2. Open dashboard:"
echo "   http://127.0.0.1:3100/dashboard"
echo ""
echo "3. Run demo workflow:"
echo "   npm run run:demo"
echo ""
echo "4. View CLI options:"
echo "   node src/cli.js --help"
echo ""
echo "Documentation: https://github.com/Lyx3314844-03/nexcrawl"
echo ""
