// FILE: src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // FIX: Enable CORS so your frontend (3000) can talk to your backend (3001)
  app.enableCors({
    origin: 'http://localhost:3000',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // Change port to 3001 to avoid conflict with React
  await app.listen(3001); 
  console.log('Seeker Backend running on http://localhost:3001');
}
bootstrap();
