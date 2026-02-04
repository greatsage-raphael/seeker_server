import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SlidesModule } from './slides/slides.module';
import { VideoModule } from './video/video.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), // Loads your .env file
    SlidesModule,
    VideoModule,
  ],
})
export class AppModule {}
