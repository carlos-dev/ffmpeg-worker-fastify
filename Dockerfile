FROM node:20-slim

# 1. Instala o FFmpeg (Obrigatório)
RUN apt-get update && apt-get install -y ffmpeg

WORKDIR /app

# 2. Copia os arquivos de dependência
COPY package*.json ./

# 3. Instala TODAS as dependências (incluindo TypeScript para o build)
# Removemos o --production aqui para ter acesso ao 'tsc'
RUN npm install

# 4. Copia o código fonte
COPY . .

# 5. Roda o Build do TypeScript (Isso cria a pasta /dist)
RUN npm run build

# 6. Expõe a porta
EXPOSE 3000

# 7. Inicia o servidor compilado
CMD ["npm", "start"]