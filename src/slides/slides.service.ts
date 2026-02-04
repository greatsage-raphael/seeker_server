import { Injectable, OnModuleInit } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

@Injectable()
export class SlidesService implements OnModuleInit {
    private supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    private processingQueue = new Set<string>();

    async onModuleInit() {
        // Use system FFmpeg instead of ffmpeg-static
        try {
            const { stdout } = await execAsync('which ffmpeg');
            const systemFfmpegPath = stdout.trim();
            ffmpeg.setFfmpegPath(systemFfmpegPath);
            console.log('✅ Using System FFmpeg:', systemFfmpegPath);

            // Verify drawtext filter exists
            const { stdout: filters } = await execAsync('ffmpeg -filters 2>&1 | grep drawtext');
            if (filters.includes('drawtext')) {
                console.log('✅ drawtext filter available');
            } else {
                console.error('❌ drawtext filter NOT available - install full FFmpeg');
            }
        } catch (e) {
            console.error('⚠️  System FFmpeg not found. Install with: sudo apt install ffmpeg');
        }
    }

    private getSystemFont() {
        const paths = [
            '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
            '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
        ];
        for (const p of paths) {
            if (fs.existsSync(p)) {
                console.log('✅ Using font:', p);
                return p;
            }
        }
        console.warn('⚠️  No system font found, using Arial');
        return 'Arial';
    }

    private async getGoogleGenAI() {
        const { GoogleGenAI } = await import('@google/genai');
        return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    }

    async createVideo(lessonId: string, summary: string, thoughts: string, title: string) {
        if (this.processingQueue.has(lessonId)) return;
        this.processingQueue.add(lessonId);

        const tempDir = path.resolve(process.cwd(), 'temp', lessonId);

        try {
            console.log(`🎬 PRODUCTION START: ${lessonId}`);
            if (!fs.existsSync(path.resolve(process.cwd(), 'temp'))) fs.mkdirSync(path.resolve(process.cwd(), 'temp'));
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
            fs.mkdirSync(tempDir, { recursive: true });

            await this.supabase.from('lessons').update({ video_status: 'processing' }).eq('lesson_id', lessonId);

            const ai = await this.getGoogleGenAI();
            const scriptRes = await ai.models.generateContent({
                model: 'gemini-3-pro-preview',
                contents: [{ role: 'user', parts: [{ text: `Convert to 30s slides. JSON array: [{"title": "Title", "bullets": ["A", "B"], "image_prompt": "desc", "narration": "text"}] Content: ${summary}` }] }]
            });

            const manifest = JSON.parse(scriptRes.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/```json|```/g, '') || "[]");
            const slideFiles: string[] = [];

            for (let i = 0; i < manifest.length; i++) {
                const slide = manifest[i];
                console.log(`--- Processing Slide ${i + 1} ---`);

                // 1. GENERATE ASSETS
                const imgRes = await ai.models.generateContent({
                    model: 'gemini-3-pro-image-preview',
                    contents: [{ role: 'user', parts: [{ text: slide.image_prompt + " High-fidelity illustration." }] }],
                    config: { responseModalities: ["IMAGE"] }
                });

                const audioRes = await ai.models.generateContent({
                    model: 'gemini-2.5-flash-preview-tts',
                    contents: [{ role: 'user', parts: [{ text: slide.narration }] }],
                    config: {
                        responseModalities: ["AUDIO"],
                        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
                    }
                });

                const imgPath = path.join(tempDir, `i${i}.png`);
                const audioPathPCM = path.join(tempDir, `a${i}.pcm`);
                const audioPath = path.join(tempDir, `a${i}.wav`);

                const imgB64 = imgRes.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
                const audioB64 = audioRes.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

                if (!imgB64 || !audioB64) throw new Error("Assets failed to generate");

                fs.writeFileSync(imgPath, Buffer.from(imgB64, 'base64'));
                fs.writeFileSync(audioPathPCM, Buffer.from(audioB64, 'base64'));

                // Remove existing output file if it exists
                if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

                // Convert PCM to WAV using FFmpeg
                // Gemini TTS returns: s16le format, 24000 Hz, 1 channel (mono)
                console.log(`🔊 Converting PCM to WAV ${i}...`);
                await new Promise((res, rej) => {
                    ffmpeg(audioPathPCM)
                        .inputOptions([
                            '-f s16le',      // Input format: signed 16-bit little-endian PCM
                            '-ar 24000',     // Sample rate: 24000 Hz
                            '-ac 1'          // Channels: 1 (mono)
                        ])
                        .audioCodec('pcm_s16le')
                        .audioChannels(1)
                        .audioFrequency(24000)
                        .format('wav')
                        .on('start', (cmd) => console.log('Audio conversion cmd:', cmd.substring(0, 150)))
                        .on('end', () => {
                            console.log(`✅ Converted audio ${i}`);
                            res(true);
                        })
                        .on('error', (err, stdout, stderr) => {
                            console.error("Audio conversion error:", err.message);
                            console.error("Audio stderr:", stderr);
                            rej(err);
                        })
                        .save(audioPath);
                });

                // 2. RENDER SLIDE - Use system FFmpeg instead of ffmpeg-static
                const slidePath = path.join(tempDir, `s${i}.mp4`);

                // Get font path without escaping (we'll handle in command)
                const rawFontPath = this.getSystemFont();

                // Clean text thoroughly
                const cleanTitle = slide.title.replace(/[^a-zA-Z0-9 ]/g, " ");
                const cleanBullets = slide.bullets.map((b: string) =>
                    b.replace(/[^a-zA-Z0-9 ]/g, " ")
                );

                // Build drawtext filters
                let drawtextFilters = `drawtext=fontfile=${rawFontPath}:text='${cleanTitle}':x=100:y=150:fontsize=65:fontcolor=0x22c55e`;

                cleanBullets.forEach((bullet: string, idx: number) => {
                    drawtextFilters += `,drawtext=fontfile=${rawFontPath}:text='• ${bullet}':x=100:y=${350 + (idx * 80)}:fontsize=36:fontcolor=white`;
                });

                // Complete filter chain
                const filterComplex = `[0:v]scale=960:960:force_original_aspect_ratio=increase,crop=960:960[scaled];color=s=1920x1080:c=0x062012[bg];[bg][scaled]overlay=900:60,${drawtextFilters}[outv]`;

                console.log('🔍 Filter:', filterComplex.substring(0, 150) + '...');

                await new Promise((res, rej) => {
                    const cmd = ffmpeg()
                        .input(imgPath)
                        .inputOptions(['-loop 1'])
                        .input(audioPath)
                        .complexFilter(filterComplex)
                        .outputOptions([
                            '-map [outv]',
                            '-map 1:a',
                            '-t 30',
                            '-pix_fmt yuv420p',
                            '-c:v libx264',
                            '-c:a aac',
                            '-b:a 128k',
                            '-preset ultrafast',
                            '-shortest'
                        ])
                        .save(slidePath);

                    cmd.on('start', (commandLine) => {
                        console.log('🎥 FFmpeg command:', commandLine.substring(0, 200) + '...');
                    });

                    cmd.on('end', () => {
                        console.log(`✅ Rendered slide ${i}`);
                        res(true);
                    });

                    cmd.on('error', (err, stdout, stderr) => {
                        console.error("❌ FFmpeg Error:", err.message);
                        console.error("Stderr:", stderr);
                        rej(err);
                    });
                });

                slideFiles.push(slidePath);
            }

            // 3. STITCH & UPLOAD
            const finalPath = path.join(tempDir, 'final.mp4');
            const stitcher = ffmpeg();
            slideFiles.forEach(f => stitcher.input(f));

            stitcher
                .on('end', async () => {
                    const videoBuffer = fs.readFileSync(finalPath);
                    const storagePath = `${lessonId}/slides_${Date.now()}.mp4`;
                    await this.supabase.storage.from('seeker').upload(storagePath, videoBuffer, { contentType: 'video/mp4' });
                    const { data } = this.supabase.storage.from('seeker').getPublicUrl(storagePath);

                    await this.supabase.from('lessons').update({
                        video_url: data.publicUrl,
                        video_status: 'ready',
                        video_manifest: manifest
                    }).eq('lesson_id', lessonId);

                    fs.rmSync(tempDir, { recursive: true, force: true });
                    this.processingQueue.delete(lessonId);
                    console.log('🎉 PRODUCTION COMPLETE');
                })
                .on('error', (err) => {
                    console.error('❌ Stitching failed:', err);
                    throw err;
                })
                .mergeToFile(finalPath);

        } catch (e) {
            console.error('❌ CRITICAL FAILURE:', e);
            await this.supabase.from('lessons').update({ video_status: 'failed' }).eq('lesson_id', lessonId);
            this.processingQueue.delete(lessonId);
            // Keep temp files for debugging
            // if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }

    async createPodcast(lessonId: string, summary: string, title: string) {
        const tempDir = path.resolve(process.cwd(), 'temp', `pod_${lessonId}`);

        try {
            console.log(`🎙️ PODCAST PRODUCTION START: ${lessonId}`);
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

            // 1. Update status to processing
            await this.supabase.from('lessons').update({ podcast_status: 'processing' }).eq('lesson_id', lessonId);

            const ai = await this.getGoogleGenAI();

            // 2. Generate a Podcast Script (Dialogue)
            const scriptRes = await ai.models.generateContent({
                model: 'gemini-2.0-flash', // Use Flash for fast text generation
                contents: [{
                    role: 'user', parts: [{
                        text: `
                    Create a 1-minute podcast script based on this lesson: "${title}". 
                    Context: ${summary}
                    
                    The hosts are Alex (enthusiastic, curious) and Sam (expert, calm).
                    Format the output strictly as a dialogue like this:
                    Alex: [text]
                    Sam: [text]
                ` }]
                }]
            });

            const transcript = scriptRes.candidates?.[0]?.content?.parts?.[0]?.text || '';

            // 3. Generate Multi-Speaker Audio
            console.log("🔊 Generating Multi-speaker TTS...");
            const audioRes = await ai.models.generateContent({
                model: 'gemini-2.5-flash-preview-tts',
                contents: [{
                    parts: [{
                        text: `
                    # DIRECTOR'S NOTES
                    Style: Engaging educational podcast. 
                    Alex sounds youthful and Sam sounds mature and authoritative.
    
                    # TRANSCRIPT
                    ${transcript}
                ` }]
                }],
                config: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        multiSpeakerVoiceConfig: {
                            speakerVoiceConfigs: [
                                { speaker: 'Alex', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
                                { speaker: 'Sam', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } }
                            ]
                        }
                    }
                }
            });

            const audioB64 = audioRes.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (!audioB64) throw new Error("Podcast audio failed to generate");

            const pcmPath = path.join(tempDir, 'pod.pcm');
            const wavPath = path.join(tempDir, 'pod.wav');
            fs.writeFileSync(pcmPath, Buffer.from(audioB64, 'base64'));

            // 4. Convert PCM to WAV/MP3 (Gemini returns 24kHz Mono)
            await new Promise((res, rej) => {
                ffmpeg(pcmPath)
                    .inputOptions(['-f s16le', '-ar 24000', '-ac 1'])
                    .toFormat('mp3')
                    .on('end', res)
                    .on('error', rej)
                    .save(wavPath);
            });

            // 5. Upload to Supabase
            const audioBuffer = fs.readFileSync(wavPath);
            const storagePath = `${lessonId}/podcast_${Date.now()}.mp3`;

            await this.supabase.storage.from('seeker').upload(storagePath, audioBuffer, { contentType: 'audio/mpeg' });
            const { data } = this.supabase.storage.from('seeker').getPublicUrl(storagePath);

            // 6. Final Update
            await this.supabase.from('lessons').update({
                podcast_url: data.publicUrl,
                podcast_status: 'ready'
            }).eq('lesson_id', lessonId);

            console.log('🎉 PODCAST COMPLETE');
            fs.rmSync(tempDir, { recursive: true, force: true });

        } catch (e) {
            console.error('❌ PODCAST FAILURE:', e);
            await this.supabase.from('lessons').update({ podcast_status: 'failed' }).eq('lesson_id', lessonId);
        }
    }

    // Add these to your SlidesService class

    async createComic(lessonId: string, aiNotes: string, title: string) {
        const tempDir = path.resolve(process.cwd(), 'temp', `comic_${lessonId}`);

        try {
            console.log(`🎨 [${lessonId}] COMIC PRODUCTION BEGAN: Topic - ${title}`);
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

            // 1. Set Status to Processing
            await this.supabase.from('lessons').update({ comic_status: 'processing' }).eq('lesson_id', lessonId);

            const ai = await this.getGoogleGenAI();

            // --- STAGE 1: THE DIRECTOR (Analysis & Storyboarding) ---
            // This stage determines the "Visual Identity" based on the content.
            const directorPrompt = `
                Analyze the following educational topic and notes:
                TOPIC: ${title}
                NOTES: ${aiNotes.substring(0, 1500)}
    
                Your goal is to storyboard a 5-page educational comic.
                
                STEP 1: Identify the CORE AESTHETIC. 
                - If historical: Use an era-appropriate art style (e.g., Oil painting, Ink wash, or Vintage sketch).
                - If scientific: Use a technical, clean, or diagrammatic style.
                - If sports/action: Use high-energy Manga/Dynamic styles.
                
                STRICT RULE: Do NOT use generic sci-fi, space, or superhero tropes unless the notes are specifically about those topics. Ground all visuals in the geography and era of the notes.
    
                STEP 2: Define Visual Anchors.
                - Describe 1-2 consistent characters and the specific color palette (e.g., "Deep ochres and forest greens for Buganda history").
    
                STEP 3: Storyboard 5 Pages.
                - Page 1 must be a cinematic Title Page.
                - Pages 2-5 must explain the key facts from the notes visually.
    
                OUTPUT JSON ONLY:
                {
                  "thematic_era": "string",
                  "style_guide": "detailed description of art style",
                  "visual_anchors": "detailed character/env descriptions for consistency",
                  "pages": [
                    { "page": 1, "panel_desc": "visual description", "caption": "educational text" }
                  ]
                }
            `;

            const boardRes = await ai.models.generateContent({
                model: 'gemini-3-pro-preview',
                contents: [{ role: 'user', parts: [{ text: directorPrompt }] }]
            });
            const manifest = JSON.parse(boardRes.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/```json|```/g, '').trim() || '{}');

            console.log(`📋 [${lessonId}] Style Selected: ${manifest.thematic_era} - ${manifest.style_guide}`);

            // --- STAGE 2: THE ARTIST (Stateful Continuity) ---
            const pageUrls: string[] = [];

            for (const pageData of manifest.pages) {
                console.log(`🖌️ [${lessonId}] Rendering Page ${pageData.page}/5...`);

                const artistPrompt = `
                    You are a master comic artist. Your style for this project is: ${manifest.style_guide}.
                    Visual Anchors for continuity: ${manifest.visual_anchors}.
                    Era: ${manifest.thematic_era}.
                    Maintain 100% visual consistency. Do not deviate from the established era.
                    
                    Generate Page ${pageData.page}. 
                    Visual Description: ${pageData.panel_desc}.
                    Include this Caption/Text in a professional layout: "${pageData.caption}".
                    Style Reminder: ${manifest.style_guide}.
                    Requirement: High-fidelity, 2-3 panels, cinematic lighting.
                `;

                const result = await ai.models.generateContent({
                    model: 'gemini-3-pro-image-preview',
                    contents: [{ role: 'user', parts: [{ text: artistPrompt }] }],
                    config: { responseModalities: ["IMAGE"] }
                });

                const imgPart = result.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
                if (!imgPart?.inlineData?.data) throw new Error(`Artist failed to render page ${pageData.page}`);

                // Upload to Supabase Storage
                const buffer = Buffer.from(imgPart.inlineData.data, 'base64');
                const storagePath = `comics/${lessonId}/p${pageData.page}_${Date.now()}.jpg`;

                await this.supabase.storage
                    .from('seeker')
                    .upload(storagePath, buffer, { contentType: 'image/jpeg', upsert: true });

                const { data: { publicUrl } } = this.supabase.storage.from('seeker').getPublicUrl(storagePath);
                pageUrls.push(publicUrl);
            }

            // 3. Final Database Update
            await this.supabase.from('lessons').update({
                comic_pages: pageUrls,
                comic_status: 'ready'
            }).eq('lesson_id', lessonId);

            console.log(`🎉 [${lessonId}] COMIC COMPLETE: ${pageUrls.length} pages generated.`);

            // Cleanup local temp files
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });

        } catch (error) {
            console.error(`❌ [${lessonId}] COMIC FAILED:`, error);
            await this.supabase.from('lessons').update({ comic_status: 'failed' }).eq('lesson_id', lessonId);
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }

    // Inside SlidesService class...

async generateSkillTree(courseId: string) {
    // 1. Fetch existing modules and lessons
    const { data: course } = await this.supabase
        .from('courses')
        .select(`*, modules(id, title, order_index, lesson_plans(id, title, order_index, status))`)
        .eq('id', courseId)
        .single();

    if (!course) throw new Error("Course not found");

    // Check if tree already exists
    const { data: existingTree } = await this.supabase.from('skill_trees').select('id').eq('course_id', courseId).single();
    if (existingTree) return { message: 'Tree already exists', treeId: existingTree.id };

    // 2. Prepare data for Gemini to Layout
    const flatLessons = course.modules
        .sort((a, b) => a.order_index - b.order_index)
        .flatMap((m, mIdx) => 
            m.lesson_plans
                .sort((a, b) => a.order_index - b.order_index)
                .map((l, lIdx) => ({ 
                    id: l.id, 
                    title: l.title, 
                    module: m.title, 
                    globalIndex: mIdx * 10 + lIdx // Helper for linear dependency
                }))
        );

    // 3. AI Layout Generation
    const ai = await this.getGoogleGenAI();
    const prompt = `
        I have a list of lessons for a course: "${course.title}".
        List: ${JSON.stringify(flatLessons.map(l => ({ id: l.id, title: l.title })))}

        I need you to arrange these into a visual Skill Tree RPG-style map.
        
        Rules:
        1. The output must be a JSON array of nodes.
        2. x_position: 0-100 (horizontal canvas percent).
        3. y_position: 0-100 (vertical canvas percent). Top (0) is start, Bottom (100) is end.
        4. Organize them logically. Usually earlier lessons at top, later at bottom. Branches are cool.
        5. "dependencies": array of IDs of the *immediate* parent node(s).
        
        Output JSON only:
        [
            { "lesson_id": "uuid", "x": 50, "y": 10, "dependencies": [] }
        ]
    `;

    const result = await ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });

    const layout = JSON.parse(result.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/```json|```/g, '').trim() || "[]");

    // 4. Save to DB
    const { data: newTree } = await this.supabase.from('skill_trees').insert({ course_id: courseId }).select().single();

    const nodesToInsert = layout.map((node: any) => {
        const originalLesson = flatLessons.find(l => l.id === node.lesson_id);
        // Fallback status logic
        const lessonStatus = course.modules.flatMap(m => m.lesson_plans).find(l => l.id === node.lesson_id)?.status || 'locked';

        return {
            tree_id: newTree.id,
            lesson_plan_id: node.lesson_id,
            label: originalLesson?.title || "Unknown Lesson",
            x_position: node.x,
            y_position: node.y,
            dependencies: node.dependencies,
            status: lessonStatus
        };
    });

    await this.supabase.from('skill_nodes').insert(nodesToInsert);
    return { message: 'Tree Generated', treeId: newTree.id };
}
}