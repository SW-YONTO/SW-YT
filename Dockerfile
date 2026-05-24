FROM node:20-bookworm-slim

# Install Python 3 and curl (needed for yt-dlp download and ffmpeg)
RUN apt-get update && apt-get install -y python3 curl && rm -rf /var/lib/apt/lists/*

# Download the latest yt-dlp binary and make it executable
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Copy package configurations and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application
COPY . .

# Tell server.js to use the latest system yt-dlp binary
ENV YOUTUBE_DL_PATH=/usr/local/bin/yt-dlp

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
