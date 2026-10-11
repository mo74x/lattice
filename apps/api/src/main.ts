import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as express from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Retain raw buffer for constant-time HMAC verification
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  await app.listen(3000);
  console.log('Lattice Ingestion Gateway listening on :3000');
}
bootstrap();