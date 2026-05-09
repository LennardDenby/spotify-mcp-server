FROM node:22-alpine AS build

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=6768

COPY package.json ./
RUN npm install --omit=dev

COPY --from=build /app/build ./build

EXPOSE 6768

CMD ["npm", "run", "start"]
