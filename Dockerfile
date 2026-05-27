FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm config set registry https://mirrors.cloud.tencent.com/npm/ \
  && npm install --omit=dev

COPY . .

ENV PORT=80
EXPOSE 80

CMD ["npm", "start"]
