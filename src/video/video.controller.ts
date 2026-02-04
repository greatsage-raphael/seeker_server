import { Controller, Post, Body } from '@nestjs/common';
import { VideoService } from './video.service';

@Controller('video')
export class VideoController {
  constructor(private readonly videoService: VideoService) {}

  @Post('generate-cinematic')
  async generateCinematic(
    @Body() body: { lessonId: string; summary: string; title: string; studentId: string }
  ) {
    // Run async to avoid gateway timeouts
    this.videoService.produceCinematicExplainer(
      body.lessonId,
      body.summary,
      body.title,
      body.studentId,
    );
    return { message: 'Veo Cinematic production sequence initiated' };
  }
}