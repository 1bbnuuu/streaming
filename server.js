const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(cors());

// Serve stream files with proper headers
app.use('/stream', express.static(path.join(__dirname, 'stream'), {
    setHeaders: (res, path) => {
        if (path.endsWith('.m3u8')) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-cache');
        } else if (path.endsWith('.ts')) {
            res.setHeader('Content-Type', 'video/mp2t');
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

// Serve static files
app.use(express.static('public'));

let ffmpegProcess = null;
let streamActive = false;

// Buat direktori stream jika belum ada
const streamDir = path.join(__dirname, 'stream');
if (!fs.existsSync(streamDir)) {
    fs.mkdirSync(streamDir, { recursive: true });
}

// Konfigurasi RTSP
const RTSP_CONFIG = {
    url: 'rtsp://admin:CctvIbnu29@192.168.18.154:554/11',
    outputPath: path.join(__dirname, 'stream', 'index.m3u8')
};

// API endpoint untuk memulai stream
app.post('/api/start-stream', (req, res) => {
    if (streamActive) {
        return res.json({ 
            success: false, 
            message: 'Stream sudah aktif' 
        });
    }

    try {
        // Hapus file stream yang lama
        cleanupStreamFiles();

        // Perintah ffmpeg - Fix audio encoding
        const ffmpegArgs = [
            '-rtsp_transport', 'tcp',
            '-i', RTSP_CONFIG.url,
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-ar', '44100',
            '-b:a', '128k',
            '-f', 'hls',
            '-hls_time', '2',
            '-hls_list_size', '3',
            '-hls_flags', 'delete_segments+independent_segments',
            '-hls_allow_cache', '0',
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', path.join(streamDir, 'segment_%03d.ts'),
            RTSP_CONFIG.outputPath
        ];

        // Spawn ffmpeg process
        ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        ffmpegProcess.stdout.on('data', (data) => {
            console.log(`FFmpeg stdout: ${data}`);
        });

        ffmpegProcess.stderr.on('data', (data) => {
            console.log(`FFmpeg stderr: ${data}`);
        });

        ffmpegProcess.on('close', (code) => {
            console.log(`FFmpeg process exited with code ${code}`);
            streamActive = false;
            ffmpegProcess = null;
        });

        ffmpegProcess.on('error', (error) => {
            console.error(`FFmpeg error: ${error}`);
            streamActive = false;
            ffmpegProcess = null;
        });

        streamActive = true;
        
        res.json({ 
            success: true, 
            message: 'Stream dimulai',
            pid: ffmpegProcess.pid
        });

    } catch (error) {
        console.error('Error starting stream:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Gagal memulai stream',
            error: error.message
        });
    }
});

// API endpoint untuk menghentikan stream
app.post('/api/stop-stream', (req, res) => {
    if (!streamActive || !ffmpegProcess) {
        return res.json({ 
            success: false, 
            message: 'Stream tidak aktif' 
        });
    }

    try {
        // Kill ffmpeg process
        ffmpegProcess.kill('SIGTERM');
        
        // Tunggu sebentar lalu force kill jika perlu
        setTimeout(() => {
            if (ffmpegProcess && !ffmpegProcess.killed) {
                ffmpegProcess.kill('SIGKILL');
            }
        }, 5000);

        streamActive = false;
        ffmpegProcess = null;

        // Cleanup stream files
        cleanupStreamFiles();

        res.json({ 
            success: true, 
            message: 'Stream dihentikan' 
        });

    } catch (error) {
        console.error('Error stopping stream:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Gagal menghentikan stream',
            error: error.message
        });
    }
});

// Debug endpoint
app.get('/debug', (req, res) => {
    const streamPath = path.join(__dirname, 'stream');
    const files = fs.existsSync(streamPath) ? fs.readdirSync(streamPath) : [];
    
    res.json({
        streamDir: streamPath,
        files: files,
        m3u8Exists: fs.existsSync(path.join(streamPath, 'index.m3u8')),
        serverTime: new Date().toISOString(),
        streamActive: streamActive,
        processRunning: ffmpegProcess !== null
    });
});

// API endpoint untuk cek status stream
app.get('/api/stream-status', (req, res) => {
    const m3u8Exists = fs.existsSync(RTSP_CONFIG.outputPath);
    
    res.json({
        active: streamActive,
        processRunning: ffmpegProcess !== null,
        m3u8FileExists: m3u8Exists,
        pid: ffmpegProcess ? ffmpegProcess.pid : null
    });
});

// API endpoint untuk mendapatkan konfigurasi
app.get('/api/config', (req, res) => {
    res.json({
        rtspUrl: RTSP_CONFIG.url.replace(/\/\/.*@/, '//***:***@'), // Hide credentials
        streamPath: '/stream/index.m3u8',
        serverPort: PORT
    });
});

// Fungsi untuk membersihkan file stream
function cleanupStreamFiles() {
    try {
        const files = fs.readdirSync(streamDir);
        files.forEach(file => {
            if (file.endsWith('.ts') || file.endsWith('.m3u8')) {
                fs.unlinkSync(path.join(streamDir, file));
            }
        });
        console.log('Stream files cleaned up');
    } catch (error) {
        console.error('Error cleaning up stream files:', error);
    }
}

// Serve HTML file
app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        res.send(`
            <h1>File HTML tidak ditemukan</h1>
            <p>Pastikan file index.html ada di folder: ${htmlPath}</p>
            <p>Struktur folder yang benar:</p>
            <pre>
streaming/
├── server.js
├── package.json
├── public/
│   └── index.html
└── stream/
            </pre>
        `);
    }
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down server...');
    
    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGTERM');
    }
    
    cleanupStreamFiles();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Shutting down server...');
    
    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGTERM');
    }
    
    cleanupStreamFiles();
    process.exit(0);
});

// Function to find available port
// async function findAvailablePort(startPort) {
//     const net = require('net');
    
//     return new Promise((resolve) => {
//         const server = net.createServer();
//         server.listen(startPort, () => {
//             const port = server.address().port;
//             server.close(() => resolve(port));
//         });
//         server.on('error', () => {
//             findAvailablePort(startPort + 1).then(resolve);
//         });
//     });
// }

// Start server with available port
async function startServer() {
    const PORT = process.env.PORT || 3000;

    app.listen(PORT, () => {
        console.log(`🚀 CCTV Streaming Server running on http://localhost:${PORT}`);
        console.log(`📁 Stream files will be saved to: ${streamDir}`);
        console.log(`📹 RTSP Source: ${RTSP_CONFIG.url.replace(/\/\/.*@/, '//***:***@')}`);
        console.log(`\n🌐 Access from other devices: http://[YOUR-IP]:${PORT}`);
    });
}


startServer();

module.exports = app;