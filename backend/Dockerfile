FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm ci

# Copy the rest of the application
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 8080

# Run migrations and start the server
CMD ["sh", "-c", "npm run prisma:deploy && npm run start"]
