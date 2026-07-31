#!/bin/bash
set -euo pipefail

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

IMAGE_NAME="flowforge-sdlc"
CONTAINER_NAME="flowforge-sdlc"

# Check Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed. Please install Docker first.${NC}"
    exit 1
fi

# Check Docker is running
if ! docker info &> /dev/null; then
    echo -e "${RED}Error: Docker is not running. Please start Docker and try again.${NC}"
    exit 1
fi

# Build Docker image
echo -e "${YELLOW}Building Docker image...${NC}"
docker build -t "${IMAGE_NAME}:latest" .
echo -e "${GREEN}Build complete.${NC}"

# Stop and remove existing container
echo -e "${YELLOW}Stopping existing container (if any)...${NC}"
docker stop "${CONTAINER_NAME}" 2>/dev/null || true
docker rm "${CONTAINER_NAME}" 2>/dev/null || true

# Run new container
echo -e "${YELLOW}Starting new container...${NC}"
docker run -d --name "${CONTAINER_NAME}" -p 80:80 --restart unless-stopped "${IMAGE_NAME}:latest"

# Health check
echo -e "${YELLOW}Waiting for container to be ready...${NC}"
sleep 3

if curl -sf http://localhost/ > /dev/null 2>&1; then
    echo -e "${GREEN}Deployment successful!${NC}"
    echo -e "${GREEN}Application is running at: http://localhost${NC}"
else
    echo -e "${RED}Health check failed. Check container logs with: docker logs ${CONTAINER_NAME}${NC}"
    exit 1
fi
