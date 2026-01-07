# Use uma versão leve do Node
FROM node:20-slim

# Instala FFmpeg (Obrigatório para o fluent-ffmpeg funcionar)
RUN apt-get update && apt-get install -y ffmpeg

# Define diretório de trabalho
WORKDIR /app

# Copia e instala dependências
COPY package*.json ./
RUN npm install --production

# Copia o resto do código
COPY . .

# Expõe a porta (padrão do Fastify/Railway)
EXPOSE 3000

# Inicia o servidor
CMD ["npm", "start"]