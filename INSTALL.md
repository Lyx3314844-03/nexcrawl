# Installation Guide

## Prerequisites

- **Node.js** v20.0.0 or higher
- **npm** (comes with Node.js)
- **Git** (for cloning the repository)

## Quick Install

### Windows

```bash
# Double-click the installer
install-windows.bat

# Or run from command line
.\install-windows.bat
```

### macOS

```bash
# Make script executable
chmod +x install-macos.sh

# Run installer
./install-macos.sh
```

### Linux

```bash
# Make script executable
chmod +x install-linux.sh

# Run installer
./install-linux.sh
```

## Manual Installation

### 1. Clone the repository

```bash
git clone https://github.com/Lyx3314844-03/nexcrawl.git
cd nexcrawl
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start the server

```bash
npm start
```

### 4. Open the dashboard

Visit: http://127.0.0.1:3100/dashboard

## Installation by Platform

### Windows Detailed Steps

1. **Install Node.js**
   - Download from https://nodejs.org/
   - Choose the LTS version (v20 or higher)
   - Run the installer and follow the wizard
   - Restart your terminal after installation

2. **Verify installation**
   ```cmd
   node -v
   npm -v
   ```

3. **Run the installer**
   ```cmd
   install-windows.bat
   ```

4. **Start the application**
   ```cmd
   npm start
   ```

### macOS Detailed Steps

1. **Install Node.js** (choose one method)

   Using Homebrew:
   ```bash
   brew install node
   ```

   Or download from https://nodejs.org/

2. **Verify installation**
   ```bash
   node -v
   npm -v
   ```

3. **Run the installer**
   ```bash
   chmod +x install-macos.sh
   ./install-macos.sh
   ```

4. **Start the application**
   ```bash
   npm start
   ```

### Linux Detailed Steps

1. **Install Node.js**

   **Ubuntu/Debian:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

   **CentOS/RHEL:**
   ```bash
   curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
   sudo yum install -y nodejs
   ```

   **Arch Linux:**
   ```bash
   sudo pacman -S nodejs npm
   ```

   **Using nvm (recommended for version management):**
   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
   source ~/.bashrc
   nvm install 20
   ```

2. **Verify installation**
   ```bash
   node -v
   npm -v
   ```

3. **Run the installer**
   ```bash
   chmod +x install-linux.sh
   ./install-linux.sh
   ```

4. **Start the application**
   ```bash
   npm start
   ```

## Docker Installation

```bash
# Build the image
npm run docker
# or
docker build -t nexcrawl .

# Run the container
docker run -p 3100:3100 nexcrawl
```

## Kubernetes Installation

Deployment files are available in the `deploy/` directory:

```bash
# Apply Kubernetes manifests
kubectl apply -f deploy/k8s/

# Or use Helm
helm install nexcrawl deploy/helm/
```

## Verify Installation

After installation, verify everything works:

```bash
# Start the server
npm start

# In another terminal, test the API
curl http://127.0.0.1:3100/health
curl http://127.0.0.1:3100/capabilities

# Run the demo workflow
npm run run:demo

# Run tests
npm test

# Run linter
npm run lint
```

## Environment Variables

Optional environment variables for production:

```bash
# API Key protection
export NexCrawl_API_KEY=your-secret-api-key

# Credential encryption
export NexCrawl_VAULT_KEY=replace-with-long-random-secret
```

## Troubleshooting

### Node.js version too old

```bash
# Check current version
node -v

# Upgrade using nvm
nvm install 20
nvm use 20
```

### Permission issues (Linux/macOS)

```bash
# Don't use sudo with npm
# Fix npm permissions:
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

### Port already in use

```bash
# Change the port
node src/cli.js serve --port 3200
```

### Dependencies installation fails

```bash
# Clear npm cache
npm cache clean --force

# Remove node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

## Next Steps

- [Quick Start Guide](./docs/QUICK_START_ZH.md)
- [API Documentation](./docs/PLATFORM_API.md)
- [Workflow Guide](./docs/WORKFLOW_GUIDE.md)
- [Capabilities](./docs/CAPABILITIES.md)
