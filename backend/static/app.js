/**
 * VINYLflowplus Frontend Application v1.0.0
 * Multi-Format Edition
 */

function vinylApp() {
    return {
        ws: null, dragging: false, showSettings: false, uploadProgress: 0, searchLoading: false,
        trackCountMismatch: false, uploadedFiles: [], currentFileId: null, currentFile: null,
        selectedFileIds: [], detectedTracks: [], currentPlayingTrack: null, waveform: null,
        waveformLoading: false, waveformRegions: null, currentZoom: 50, searchQuery: '',
        searchResults: [], selectedRelease: null, customMapping: [], searchAbortController: null,
        isProcessing: false, processingProgress: 0, processingMessage: '', successMessage: '',
        lastProcessedIds: [], outputFormats: ['flac'], availableFormats: [], restorationLevel: 0,
        config: { silence_threshold: -40, min_silence_duration: 1.5, output_dir: '', flac_compression: 8 },
        supportedExtensions: ['.wav', '.aiff', '.aif', '.flac', '.mp3'],
        discogsConfigured: true, darkMode: localStorage.getItem('darkMode') !== 'false',

        async init() {
            this.updateDarkMode();
            document.addEventListener('contextmenu', e => { if (!e.target.closest('input, textarea')) e.preventDefault(); }, true);
            await this.loadConfig(); await this.loadFormats(); await this.fetchQueue(); this.connectWebSocket();
            this.$watch('currentFile', (f) => { if (f && !this.searchQuery) this.searchQuery = this.cleanFilename(f.filename); });
            this.$watch('currentFileId', (id) => { if (id && !this.selectedFileIds.includes(id)) this.selectedFileIds = [id]; });
        },

        toggleDarkMode() { 
            this.darkMode = !this.darkMode; 
            localStorage.setItem('darkMode', this.darkMode); 
            this.updateDarkMode(); 
        },
        updateDarkMode() { 
            if (this.darkMode) {
                document.documentElement.classList.add('dark');
            } else {
                document.documentElement.classList.remove('dark');
            }
        },

        toggleFormat(id) {
            if (this.outputFormats.includes(id)) {
                if (this.outputFormats.length > 1) this.outputFormats = this.outputFormats.filter(f => f !== id);
            } else {
                this.outputFormats.push(id);
            }
        },

        async fetchQueue() {
            try {
                const r = await fetch('/api/queue'); const d = await r.json();
                this.uploadedFiles = d.uploaded || [];
                this.uploadedFiles.sort((a, b) => a.filename.localeCompare(b.filename));
                if (this.uploadedFiles.length > 0 && !this.currentFileId) this.selectFile(this.uploadedFiles[0].id);
            } catch (e) {}
        },

        selectFile(id) {
            this.currentFileId = id; this.currentFile = this.uploadedFiles.find(f => f.id === id);
            this.detectedTracks = this.currentFile?.detected_tracks ? JSON.parse(JSON.stringify(this.currentFile.detected_tracks)) : [];
            this.searchResults = []; this.selectedRelease = null; this.successMessage = '';
            this.processingProgress = 0; this.processingMessage = ''; this.destroyWaveform();
            if (this.currentFile) { this.searchQuery = this.cleanFilename(this.currentFile.filename); if (this.detectedTracks.length > 0) this.initWaveform(); }
        },

        async removeFile(id) {
            if (!confirm('Remove file?')) return;
            try { await fetch(`/api/queue/${id}`, { method: 'DELETE' }); await this.fetchQueue(); } catch (e) {}
        },

        async uploadFiles(files) {
            if (files.length === 0) return;
            const fd = new FormData(); files.forEach(f => fd.append('files', f));
            this.isProcessing = true; this.processingMessage = 'Uploading...';
            try { await fetch('/api/upload', { method: 'POST', body: fd }); await this.fetchQueue(); } catch (e) {}
            finally { this.isProcessing = false; this.processingMessage = ''; }
        },

        async analyzeFile() {
            if (!this.currentFileId) return;
            this.waveformLoading = true;
            try {
                const r = await fetch('/api/analyze', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({file_id: this.currentFileId}) });
                const d = await r.json(); this.detectedTracks = d.tracks.map(t => ({ ...t, editing: false, ignored: false }));
                await this.initWaveform(); if (this.searchQuery) await this.searchDiscogs();
            } catch (e) {} finally { this.waveformLoading = false; }
        },

        async searchDiscogs() {
            if (!this.searchQuery.trim()) return;
            if (this.searchAbortController) this.searchAbortController.abort();
            this.searchAbortController = new AbortController(); this.searchLoading = true;
            try {
                const r = await fetch('/api/search', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({query: this.searchQuery}), signal: this.searchAbortController.signal });
                const d = await r.json(); this.searchResults = d.results;
            } catch (e) {} finally { if (!this.searchAbortController.signal.aborted) this.searchLoading = false; }
        },

        selectRelease(r) { 
            this.selectedRelease = r; 
            const tMap = this.allDetectedTracks.filter(t => !t.ignored);
            this.customMapping = Array.from({ length: tMap.length }, (_, i) => i);
            if (this.waveform) this.addTrackRegions();
        },

        async processFiles() {
            if (this.selectedFileIds.length === 0 && this.currentFileId) this.selectedFileIds = [this.currentFileId];
            if (this.selectedFileIds.length === 0) { alert('Select files first'); return; }
            if (!this.selectedRelease) { alert('Select a release first'); return; }
            this.lastProcessedIds = [...this.selectedFileIds];
            if (this.selectedFileIds.length > 1) return this.multiProcessFiles();
            return this.processFile();
        },

        async processFile() {
            this.isProcessing = true; this.processingProgress = 0.02; this.processingMessage = 'Processing...';
            const active = this.detectedTracks.filter(t => !t.ignored);
            const mapping = active.map((t, i) => {
                const discogsTrack = this.selectedRelease.tracks[this.customMapping[this.detectedTracks.indexOf(t)]];
                return { 
                    detected: t.number, 
                    discogs: discogsTrack?.position || '?',
                    title: discogsTrack?.title || ''
                };
            });
            const bounds = active.map(t => ({ number: t.number, start: t.start, end: t.end, duration: t.duration || (t.end-t.start) }));
            try {
                const res = await fetch('/api/process', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ 
                    file_id: this.currentFileId, release_id: this.selectedRelease.id, track_mapping: mapping, 
                    track_boundaries: bounds, output_formats: this.outputFormats, restoration_level: this.restorationLevel 
                }) });
                const data = await res.json(); this.startProcessPolling(data.job_id);
            } catch (e) { this.isProcessing = false; }
        },

        async multiProcessFiles() {
            this.isProcessing = true; this.processingProgress = 0.02; this.processingMessage = 'Processing batch...';
            const mapping = []; const boundsMap = {};
            this.selectedFileIds.forEach(id => {
                const f = this.uploadedFiles.find(x => x.id === id);
                if (f && f.detected_tracks) boundsMap[id] = f.detected_tracks.map(t => ({ number: t.number, start: t.start, end: t.end, duration: t.duration || (t.end-t.start) }));
            });
            this.allDetectedTracks.filter(t => !t.ignored).forEach((t, i) => {
                const dt = this.selectedRelease.tracks[this.customMapping[i] || 0];
                if (dt) mapping.push({ 
                    source_file_id: t.file_id, 
                    detected: t.number, 
                    discogs: dt.position,
                    title: dt.title 
                });
            });
            try {
                const res = await fetch('/api/multi-process', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ 
                    release_id: this.selectedRelease.id, track_mapping: mapping, track_boundaries_map: boundsMap, 
                    output_formats: this.outputFormats, restoration_level: this.restorationLevel 
                }) });
                const data = await res.json(); this.startProcessPolling(data.job_id);
            } catch (e) { this.isProcessing = false; }
        },

        startProcessPolling(jobId) {
            const timer = setInterval(async () => {
                try {
                    const r = await fetch(`/api/process/${jobId}`); const j = await r.json();
                    if (j.status === 'processing') { this.processingProgress = j.progress || 0.1; this.processingMessage = j.message || 'Processing...'; }
                    else if (j.status === 'complete') { 
                        clearInterval(timer); this.isProcessing = false; 
                        this.successMessage = `Successfully processed ${j.tracks.length} files.`; this.fetchQueue(); 
                    }
                    else if (j.status === 'error') { clearInterval(timer); this.isProcessing = false; alert('Error: ' + j.error); }
                } catch (e) {}
            }, 1000);
        },

        stopProcessPolling() { if(this.processPollTimer) clearInterval(this.processPollTimer); this.processPollTimer = null; },

        async resetForNextFile() {
            const ids = [...this.lastProcessedIds]; this.successMessage = ''; this.isProcessing = false;
            for (const id of ids) { await fetch(`/api/queue/${id}`, { method: 'DELETE' }).catch(()=>{}); }
            await this.fetchQueue(); this.lastProcessedIds = [];
            if (this.uploadedFiles.length > 0) {
                this.selectFile(this.uploadedFiles[0].id);
            } else {
                this.currentFileId = null; 
                this.currentFile = null; 
                this.selectedFileIds = []; 
                this.detectedTracks = [];
                this.selectedRelease = null;
                this.searchResults = [];
                this.destroyWaveform();
            }
        },

        async initWaveform() {
            if (!this.currentFileId || this.waveform) return;
            this.waveformLoading = true; await new Promise(r => setTimeout(r, 100));
            try {
                this.waveform = WaveSurfer.create({ container: '#waveform', waveColor: '#2563eb', progressColor: '#E5A100', cursorColor: '#E5A100', height: 250, normalize: true, backend: 'MediaElement' });
                this.waveformRegions = this.waveform.registerPlugin(WaveSurfer.Regions.create());
                const p = await (await fetch(`/api/waveform-peaks/${this.currentFileId}`)).json();
                this.waveform.load(`/api/audio/${this.currentFileId}`, p.peaks);
                this.waveform.on('ready', () => { this.waveform.zoom(document.getElementById('waveform').offsetWidth / this.waveform.getDuration()); this.addTrackRegions(); this.waveformLoading = false; });
            } catch (e) { this.waveformLoading = false; }
        },

        getTrackColor(i) {
            const colors = ['rgba(229, 161, 0, 0.8)', 'rgba(59, 130, 246, 0.8)', 'rgba(16, 185, 129, 0.8)', 'rgba(139, 92, 246, 0.8)', 'rgba(236, 72, 153, 0.8)'];
            return colors[i % colors.length];
        },

        addTrackRegions() {
            if(!this.waveformRegions) return; this.waveformRegions.clearRegions();
            this.detectedTracks.forEach((t, i) => { this.waveformRegions.addRegion({ start: t.start, end: t.end, color: t.ignored ? 'rgba(100, 100, 100, 0.3)' : this.getTrackColor(i).replace('0.8', '0.2'), drag: true, resize: true, id: `track-${t.number}`, content: `T${t.number}` }); });
        },

        jumpToTrack(t) { if(this.waveform) { this.waveform.setTime(t.start); this.waveform.play(); } },
        playWaveform() { this.waveform?.play(); },
        stopWaveform() { this.waveform?.pause(); },
        destroyWaveform() { this.waveform?.destroy(); this.waveform = null; this.waveformRegions = null; },

        async loadConfig() { try { this.config = await (await fetch('/api/config')).json(); } catch(e){} },
        async loadFormats() { try { this.availableFormats = (await (await fetch('/api/formats')).json()).formats; } catch(e){} },
        async saveConfig() { await fetch('/api/config', { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(this.config) }); this.showSettings = false; },
        async chooseOutputFolder() { const r = await fetch('/api/utils/select-folder', { method: 'POST' }); const d = await r.json(); if(d.path) this.config.output_dir = d.path; },
        async checkStatus() { try { const r = await fetch('/api/status'); const d = await r.json(); this.discogsConfigured = d.discogs_configured; } catch(e){} },

        handleDrop(e) { this.dragging = false; this.uploadFiles(Array.from(e.dataTransfer.files).filter(f => this.isSupportedFile(f.name))); },
        handleFileSelect(e) { this.uploadFiles(Array.from(e.target.files)); },
        isSupportedFile(f) { return this.supportedExtensions.includes(f.toLowerCase().substring(f.lastIndexOf('.'))); },
        
        selectAllFiles() { this.selectedFileIds = this.uploadedFiles.map(f => f.id); },
        deselectAllFiles() { this.selectedFileIds = []; },
        toggleFileSelection(id) { if (this.selectedFileIds.includes(id)) this.selectedFileIds = this.selectedFileIds.filter(x => x !== id); else { this.selectedFileIds.push(id); this.selectFile(id); } },

        get allDetectedTracks() {
            let tracks = [];
            this.selectedFileIds.forEach(id => {
                const file = this.uploadedFiles.find(f => f.id === id);
                if (file && file.detected_tracks) file.detected_tracks.forEach(t => tracks.push({ ...t, file_id: id, filename: file.filename }));
            });
            if (tracks.length === 0 && this.detectedTracks.length > 0) return this.detectedTracks.map(t => ({ ...t, file_id: this.currentFileId, filename: this.currentFile?.filename }));
            return tracks;
        },

        statusClass(s) {
            if(s==='uploaded') return 'text-blue-400'; if(s==='analyzed') return 'text-purple-400';
            if(s==='processing') return 'text-brand animate-pulse'; if(s==='completed') return 'text-green-400';
            return 'text-gray-500';
        },

        connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
            ws.onmessage = (e) => { 
                if (e.data === 'pong') return; try { const d = JSON.parse(e.data); 
                if (d.type === 'progress' && this.isProcessing) { this.processingProgress = d.progress; this.processingMessage = d.message; } 
                else if (d.type === 'complete' && (d.file_id === this.currentFileId || d.file_id === 'multi')) { this.isProcessing = false; this.successMessage = 'Success!'; } } catch (err) {} 
            };
            ws.onclose = () => setTimeout(() => this.connectWebSocket(), 3000);
        },

        cleanFilename(f) { return f.replace(/\.(wav|aiff|aif|flac|mp3)$/i, "").replace(/[-_]+/g, ' ').trim(); },
        formatSize(b) { if(!b) return '0 B'; const k=1024, s=['B','KB','MB','GB'], i=Math.floor(Math.log(b)/Math.log(k)); return (b/Math.pow(k,i)).toFixed(2)+' '+s[i]; },
        formatDuration(s) { if(!s) return '0:00'; return Math.floor(s/60)+':'+Math.floor(s%60).toString().padStart(2,'0'); }
    };
}
