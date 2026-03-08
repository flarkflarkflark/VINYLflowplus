/**
 * VINYLflowplus Frontend Application v1.0.3
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

        async mergeFiles() {
            if (this.selectedFileIds.length < 2) return;
            this.isProcessing = true; this.processingMessage = 'Merging tracks...';
            try {
                const r = await fetch('/api/merge', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({file_ids: this.selectedFileIds}) });
                const d = await r.json();
                await this.fetchQueue();
                this.selectedFileIds = [];
                this.selectFile(d.file_id);
                await this.analyzeFile();
            } catch (e) {
                alert('Merge failed: ' + e);
            } finally {
                this.isProcessing = false;
                this.processingMessage = '';
            }
        },

        async analyzeFile() {
            if (!this.currentFileId) return;
            this.waveformLoading = true;
            try {
                const r = await fetch('/api/analyze', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({file_id: this.currentFileId}) });
                const d = await r.json(); this.detectedTracks = d.tracks.map(t => ({ ...t, editing: false, ignored: false }));
                await this.initWaveform(); if (this.searchQuery) await this.searchDiscogs();
            } catch (e) {
                console.error('Analysis failed:', e);
                alert('Analysis failed. Please check the terminal logs for details.');
            } finally { this.waveformLoading = false; }
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
                    const r = await fetch(`/api/process/${jobId}`); 
                    const j = await r.json();
                    if (j.status === 'processing') { 
                        this.processingMessage = j.message || 'Processing...'; 
                    }
                    else if (j.status === 'complete') { 
                        clearInterval(timer); 
                        this.isProcessing = false; 
                        this.successMessage = `Successfully processed ${j.tracks.length} files.`; 
                        this.fetchQueue(); 
                    }
                    else if (j.status === 'error') { 
                        clearInterval(timer); 
                        this.isProcessing = false; 
                        alert('Error: ' + j.error); 
                    }
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
            this.waveformLoading = true;
            try {
                this.waveform = WaveSurfer.create({ 
                    container: '#waveform', 
                    waveColor: '#475569', 
                    progressColor: '#E5A100', 
                    cursorColor: '#FFFFFF', 
                    cursorWidth: 2,
                    height: 180, 
                    minPxPerSec: 1,
                    normalize: true, 
                    interact: true,
                    hideScrollbar: false,
                    dragToSeek: false
                });
                
                this.waveformRegions = this.waveform.registerPlugin(WaveSurfer.Regions.create());
                
                // Wheel Zoom
                const wfContainer = document.getElementById('waveform');
                wfContainer.addEventListener('wheel', (e) => {
                    e.preventDefault();
                    const zoomLevel = this.waveform.options.minPxPerSec;
                    if (e.deltaY < 0) this.waveform.zoom(zoomLevel * 1.2);
                    else this.waveform.zoom(Math.max(1, zoomLevel / 1.2));
                }, { passive: false });

                // Grab-to-Pan Logic
                let isGrabbing = false;
                let lastX = 0;

                wfContainer.addEventListener('mousedown', (e) => {
                    if (e.button === 0) { 
                        isGrabbing = true;
                        lastX = e.clientX;
                        wfContainer.style.cursor = 'grabbing';
                    }
                });

                window.addEventListener('mousemove', (e) => {
                    if (!isGrabbing || !this.waveform) return;
                    const deltaX = e.clientX - lastX;
                    if (Math.abs(deltaX) > 1) {
                        const scrollContainer = wfContainer.querySelector('div');
                        if (scrollContainer) {
                            scrollContainer.scrollLeft -= deltaX;
                            lastX = e.clientX;
                        }
                    }
                });

                window.addEventListener('mouseup', () => {
                    isGrabbing = false;
                    if (wfContainer) wfContainer.style.cursor = 'crosshair';
                });

                // No context menu
                wfContainer.oncontextmenu = (e) => e.preventDefault();

                const p = await (await fetch(`/api/waveform-peaks/${this.currentFileId}`)).json();
                this.waveform.load(`/api/audio/${this.currentFileId}`, p.peaks);
                
                this.waveform.on('ready', () => { 
                    this.addTrackRegions(); 
                    this.waveformLoading = false; 
                });

                // Clicking the waveform (not a region) should deselect
                this.waveform.on('interaction', () => {
                    this.selectedRegionId = null;
                    this.addTrackRegions();
                });

                this.waveformRegions.on('region-clicked', (region, e) => {
                    e.stopPropagation();
                    this.selectedRegionId = region.id;
                    this.addTrackRegions();
                });

                this.waveformRegions.on('region-updated', (region) => {
                    const trackNum = parseInt(region.id.replace('track-', ''));
                    const track = this.detectedTracks.find(t => t.number === trackNum);
                    if (track) {
                        track.start = region.start;
                        track.end = region.end;
                        track.duration = region.end - region.start;
                    }
                });

            } catch (e) {
                console.error('Waveform failed:', e);
                this.waveformLoading = false; 
            }
        },

        addManualTrack(startTime) {
            // startTime is provided by waveform.getCurrentTime()
            const num = this.detectedTracks.length + 1;
            const duration = this.waveform.getDuration();
            const endTime = Math.min(startTime + 30, duration);
            const newTrack = { number: num, start: startTime, end: endTime, duration: endTime - startTime };
            this.detectedTracks.push(newTrack);
            this.detectedTracks.sort((a,b) => a.start - b.start).forEach((t, i) => t.number = i + 1);
            this.selectedRegionId = `track-${newTrack.number}`;
            this.addTrackRegions();
        },

        removeSelectedTrack() {
            if (!this.selectedRegionId) { 
                alert('Please select a track on the waveform first.'); 
                return; 
            }
            const trackNum = parseInt(this.selectedRegionId.replace('track-', ''));
            const idx = this.detectedTracks.findIndex(t => t.number === trackNum);
            if (idx !== -1) {
                this.detectedTracks.splice(idx, 1);
                this.detectedTracks.sort((a,b) => a.start - b.start).forEach((t, i) => t.number = i + 1);
                this.selectedRegionId = null;
                this.addTrackRegions();
            }
        },

        getTrackColor(i) {
            const colors = ['rgba(229, 161, 0, 0.4)', 'rgba(59, 130, 246, 0.4)', 'rgba(16, 185, 129, 0.4)', 'rgba(139, 92, 246, 0.4)'];
            return colors[i % colors.length];
        },

        addTrackRegions() {
            if(!this.waveformRegions) return; 
            this.waveformRegions.clearRegions();
            this.detectedTracks.forEach((t, i) => { 
                const isSelected = this.selectedRegionId === `track-${t.number}`;
                const reg = this.waveformRegions.addRegion({ 
                    start: t.start, 
                    end: t.end, 
                    color: isSelected ? 'rgba(229, 161, 0, 0.7)' : (t.ignored ? 'rgba(100, 100, 100, 0.3)' : this.getTrackColor(i)), 
                    drag: true, 
                    resize: true, 
                    id: `track-${t.number}`
                }); 
                if (reg.element) reg.element.setAttribute('data-region-label', `T${t.number}${isSelected ? ' (SEL)' : ''}`);
            });
        },

        jumpToTrack(t) { if(this.waveform) { this.waveform.setTime(t.start); this.waveform.play(); } },
        playWaveform() { this.waveform?.play(); },
        stopWaveform() { this.waveform?.pause(); },
        destroyWaveform() { this.waveform?.destroy(); this.waveform = null; this.waveformRegions = null; },

        async loadConfig() { 
            try { 
                this.config = await (await fetch('/api/config')).json();
                // Apply defaults if they exist
                if (this.config.default_output_formats) this.outputFormats = this.config.default_output_formats;
                if (this.config.default_restoration_level !== undefined) this.restorationLevel = this.config.default_restoration_level;
            } catch(e){} 
        },
        async loadFormats() { try { this.availableFormats = (await (await fetch('/api/formats')).json()).formats; } catch(e){} },
        async saveConfig() { await fetch('/api/config', { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(this.config) }); this.showSettings = false; },
        async saveProcessingDefaults() {
            try {
                await fetch('/api/config/processing-defaults', { 
                    method: 'POST', 
                    headers: {'Content-Type': 'application/json'}, 
                    body: JSON.stringify({ formats: this.outputFormats, restoration_level: this.restorationLevel }) 
                });
                alert('Processing settings saved as default!');
            } catch(e) { alert('Failed to save defaults.'); }
        },
        async chooseOutputFolder() { const r = await fetch('/api/utils/select-folder', { method: 'POST' }); const d = await r.json(); if(d.path) this.config.output_dir = d.path; },
        async checkStatus() { try { const r = await fetch('/api/status'); const d = await r.json(); this.discogsConfigured = d.discogs_configured; } catch(e){} },

        async quitApp() {
            try {
                fetch('/api/quit', { method: 'POST' });
                setTimeout(() => { window.close(); }, 500);
            } catch(e) { window.close(); }
        },

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
