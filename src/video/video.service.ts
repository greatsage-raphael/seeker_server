// FILE: src/video/video.service.ts
// --------------------------------------------------------------------------

import { Injectable, OnModuleInit } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { execSync } from 'child_process';

@Injectable()
export class VideoService implements OnModuleInit {
    private supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    async onModuleInit() {
        try {
            const ffmpegPath = execSync('which ffmpeg').toString().trim();
            ffmpeg.setFfmpegPath(ffmpegPath);
            console.log('✅ VideoService: Veo 3.1 Engine Initialized');
        } catch (e) {
            console.error('❌ FFmpeg not found on system.');
        }
    }

    private async getGoogleAIClient() {
        const { GoogleGenAI } = await import('@google/genai');
        // We use v1alpha for Veo and Gemini 3 features
        return new GoogleGenAI({
            apiKey: process.env.GEMINI_API_KEY!,
            apiVersion: 'v1alpha',
        });
    }

    async produceCinematicExplainer(
        lessonId: string,
        summary: string,
        title: string,
        studentId: string,
    ) {
        const tempDir = path.resolve(process.cwd(), 'temp', `veo_${lessonId}`);
        console.log(`🎬 [${lessonId}] PRODUCTION BEGAN: Independent Scene Generation Mode`);

        try {
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

            // 1. Fetch Student Context
            const { data: student } = await this.supabase
                .from('students')
                .select('interest')
                .eq('student_id', studentId)
                .single();
            const userInterests = student?.interest?.join(', ') || 'Cinematic Realism';

            await this.supabase.from('lessons').update({ animated_video_status: 'processing' }).eq('lesson_id', lessonId);

            const ai = await this.getGoogleAIClient();

            // 2. STAGE 1: Visual Identity Extraction
            console.log(`📝 [${lessonId}] Designing Visual Anchors...`);
            const identityPrompt = `
                Analyze lesson: "${title}". Context: ${summary}. Style: ${userInterests}.
                Identify ONE Main Protagonist and ONE primary Location.
                Return JSON ONLY: 
                {
                    "protagonist_description": "detailed physical description including clothing, age, hair, facial features",
                    "location_description": "detailed environmental description",
                    "art_style": "consistent visual style (e.g. 3D Animation, Studio Ghibli, Pixar, or Hyper-realism)"
                }
            `;
            const idRes = await ai.models.generateContent({
                model: 'gemini-3-pro-preview',
                contents: [{ role: 'user', parts: [{ text: identityPrompt }] }]
            });

            const idText = idRes.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/```json|```/g, '').trim();
            if (!idText) throw new Error("Failed to generate Visual Identity JSON");
            const visualId = JSON.parse(idText);

            console.log(`✅ [${lessonId}] Visual Identity:`, visualId);

            // 3. STAGE 2: Generate 2x2 Character Reference Grid (The "Character DNA")
            console.log(`🎨 [${lessonId}] Generating 2x2 Character Reference Grid...`);
            const charGridPrompt = `A professional 2x2 character reference sheet showing the same character from 4 different angles arranged in a grid:
- Top-left: Front view facing camera
- Top-right: Side profile (left side)
- Bottom-left: 3/4 three-quarter view
- Bottom-right: Back view

Character description: ${visualId.protagonist_description}
Art style: ${visualId.art_style}

Requirements:
- All 4 views must show the EXACT same character with identical features, clothing, and proportions
- Clean white background
- Professional reference sheet layout
- High detail and clarity
- Consistent lighting across all views`;

            const charGridRes = await ai.models.generateContent({
                model: 'gemini-3-pro-image-preview',
                contents: [{ role: 'user', parts: [{ text: charGridPrompt }] }],
                config: { responseModalities: ["IMAGE"] }
            });
            const charGridB64 = charGridRes.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
            if (!charGridB64) throw new Error('No character reference grid generated');

            console.log(`✅ [${lessonId}] 2x2 Character Grid created`);

            // 4. STAGE 3: Scripting (4 scenes, 8 seconds each)
            console.log(`📝 [${lessonId}] Drafting 4-scene script (8s per scene)...`);
            const scriptPrompt = `
                Write a 4-scene video script based on: ${summary}. 
                Title: ${title}
                Protagonist: ${visualId.protagonist_description}
                Location: ${visualId.location_description}
                Art Style: ${visualId.art_style}
                
                REQUIREMENTS:
                1. Each scene is exactly 8 seconds long
                2. Create a cohesive narrative that flows naturally from scene 1 to scene 4
                3. Each scene should have clear action and purpose
                4. Include dialogue and sound effects that enhance the storytelling
                5. Maintain character consistency throughout
                
                Output JSON Array ONLY (no markdown, no explanation):
                [
                    {
                        "scene": 1,
                        "action_prompt": "Detailed visual description of what happens in this scene, including camera angles, character actions, and environment. Be specific about composition and framing.",
                        "dialogue_sfx": "Exact dialogue in quotes and sound effects description. Example: A character says 'Hello there!' The sound of footsteps echoing."
                    }
                ]
            `;
            const scriptRes = await ai.models.generateContent({
                model: 'gemini-3-pro-preview',
                contents: [{ role: 'user', parts: [{ text: scriptPrompt }] }]
            });
            const scriptText = scriptRes.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/```json|```/g, '').trim();
            if (!scriptText) throw new Error("Failed to generate Script JSON");
            const script = JSON.parse(scriptText);

            console.log(`✅ [${lessonId}] Script generated with ${script.length} scenes`);

            // 5. STAGE 4: Independent Scene Generation Loop
            const videoClips: string[] = [];

            for (let i = 0; i < script.length; i++) {
                const scene = script[i];
                console.log(`🎥 [${lessonId}] Scene ${i + 1}/${script.length}: Generating...`);

                // A. Generate Scene Thumbnail (The "Anchor")
                console.log(`   📸 [${lessonId}] Creating thumbnail anchor for scene ${i + 1}...`);
                const thumbPrompt = `${scene.action_prompt}
                
Style: ${visualId.art_style}
Location: ${visualId.location_description}
Lighting: Cinematic, professional
Character: ${visualId.protagonist_description}

Create a single frame that captures the key moment of this scene. This will be used as the starting frame for video generation.`;

                const thumbRes = await ai.models.generateContent({
                    model: 'gemini-3-pro-image-preview',
                    contents: [{ role: 'user', parts: [{ text: thumbPrompt }] }],
                    config: { responseModalities: ["IMAGE"] }
                });
                const thumbB64 = thumbRes.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
                if (!thumbB64) throw new Error(`No thumbnail generated for scene ${i + 1}`);

                console.log(`   ✅ [${lessonId}] Thumbnail created for scene ${i + 1}`);

                // B. Veo 3.1 Video Generation with Both Reference Images
                console.log(`   🎬 [${lessonId}] Generating video for scene ${i + 1}...`);
                const veoPayload: any = {
                    model: 'veo-3.1-generate-preview',
                    prompt: `${scene.action_prompt}. ${scene.dialogue_sfx}. Maintain character consistency. High quality cinematic video, 24fps, smooth motion.`,
                    config: {
                        resolution: '720p',
                        aspectRatio: '16:9',
                        durationSeconds: 8,
                        personGeneration: "allow_adult",
                        referenceImages: [
                            {
                                // Character DNA Grid - ensures 3D character consistency
                                image: {
                                    imageBytes: charGridB64,
                                    mimeType: "image/png"
                                },
                                referenceType: "asset"
                            },
                            {
                                // Scene Thumbnail - ensures correct composition and lighting
                                image: {
                                    imageBytes: thumbB64,
                                    mimeType: "image/png"
                                },
                                referenceType: "asset"
                            }
                        ]
                    }
                };

                let operation = await ai.models.generateVideos(veoPayload);

                // Polling for completion
                process.stdout.write(`   ⏳ [${lessonId}] Waiting for scene ${i + 1}`);
                while (!operation.done) {
                    process.stdout.write(".");
                    await new Promise(r => setTimeout(r, 10000));

                    operation = await ai.operations.getVideosOperation({
                        operation: operation,
                    });
                }
                console.log(" ✅ Done!");

                if (!operation.response?.generatedVideos?.[0]) {
                    throw new Error(`No video generated for scene ${i + 1}`);
                }

                const currentClip = operation.response.generatedVideos[0];
                const clipPath = path.join(tempDir, `scene_${i + 1}.mp4`);

                if (!currentClip.video) {
                    throw new Error(`No video file available for scene ${i + 1}`);
                }

                // Download the clip locally
                await ai.files.download({ file: currentClip.video, downloadPath: clipPath });
                
                videoClips.push(clipPath);
                console.log(`   ✅ [${lessonId}] Scene ${i + 1} downloaded to ${clipPath}`);
            }

            // 6. STAGE 5: Stitch Videos with FFmpeg (Stream Copy Method)
            console.log(`🔗 [${lessonId}] Stitching ${videoClips.length} scenes together...`);
            
            const listFilePath = path.join(tempDir, 'clips.txt');
            const fileListContent = videoClips.map(clipPath => `file '${path.basename(clipPath)}'`).join('\n');
            fs.writeFileSync(listFilePath, fileListContent);

            const finalOutputPath = path.join(tempDir, 'final_cinematic.mp4');

            await new Promise<void>((resolve, reject) => {
                ffmpeg()
                    .input(listFilePath)
                    .inputOptions(['-f concat', '-safe 0'])
                    .outputOptions([
                        '-c copy',  // Stream copy - NO re-encoding, preserves quality and audio
                    ])
                    .output(finalOutputPath)
                    .on('start', (cmd) => {
                        console.log(`   🎞️  [${lessonId}] FFmpeg started: ${cmd}`);
                    })
                    .on('end', () => {
                        console.log(`   ✅ [${lessonId}] FFmpeg stitching complete`);
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error(`   ❌ [${lessonId}] FFmpeg error:`, err);
                        reject(err);
                    })
                    .run();
            });

            // 7. STAGE 6: Upload to Supabase
            console.log(`☁️  [${lessonId}] Final cinematic produced. Uploading...`);
            const videoBuffer = fs.readFileSync(finalOutputPath);
            const storagePath = `${lessonId}/cinematic_${Date.now()}.mp4`;

            await this.supabase.storage.from('seeker').upload(storagePath, videoBuffer, { contentType: 'video/mp4' });
            const { data: urlData } = this.supabase.storage.from('seeker').getPublicUrl(storagePath);

            await this.supabase.from('lessons').update({
                animated_video_url: urlData.publicUrl,
                animated_video_status: 'ready',
            }).eq('lesson_id', lessonId);

            console.log(`🎉 [${lessonId}] PRODUCTION COMPLETE: ${urlData.publicUrl}`);
            console.log(`📊 [${lessonId}] Stats: ${script.length} scenes × 8s = ${script.length * 8}s total video`);

            // Cleanup
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
                console.log(`🧹 [${lessonId}] Temporary files cleaned up`);
            }

        } catch (error) {
            console.error(`❌ [${lessonId}] PRODUCTION FAILED:`, error);
            await this.supabase.from('lessons').update({ animated_video_status: 'failed' }).eq('lesson_id', lessonId);
            
            // Cleanup on failure
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
            
            throw error;
        }
    }
}