import { Controller, Post, Body } from '@nestjs/common';
import { SlidesService } from './slides.service';

@Controller('slides')
export class SlidesController {
  constructor(private readonly slidesService: SlidesService) {}

  @Post('generate')
  async generate(@Body() body: { lessonId: string; summary: string; thoughts: string; title: string }) {
    // We run this asynchronously so the frontend doesn't time out
    this.slidesService.createVideo(body.lessonId, body.summary, body.thoughts, body.title);
    return { message: 'Generation started' };
  }

  @Post('generate-podcast')
async generatePodcast(@Body() body: { lessonId: string; summary: string; title: string }) {
  // Run async so frontend doesn't hang
  this.slidesService.createPodcast(body.lessonId, body.summary, body.title);
  return { message: 'Podcast generation started' };
}

// src/slides/slides.controller.ts

@Post('generate-comic')
async generateComic(@Body() body: { lessonId: string; ai_notes: string; title: string }) {
  console.log(`[Controller] Incoming Comic Request for Lesson: ${body.lessonId}`);
  // Pass ai_notes specifically to the service
  this.slidesService.createComic(body.lessonId, body.ai_notes, body.title);
  return { message: 'Comic book production initiated' };
}

@Post('generate-tree')
async generateTree(@Body() body: { courseId: string }) {
  await this.slidesService.generateSkillTree(body.courseId);
  return { status: 'done' };
}
}