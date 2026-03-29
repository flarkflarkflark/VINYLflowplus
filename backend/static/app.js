/**
 * VINYLflowplus Frontend Application v1.0.3
 * Multi-Format Edition
 */

function vinylApp() {
    return {
        ws: null, dragging: false, showSettings: false, uploadProgress: 0, searchLoading: false,
        trackCountMismatch: false, uploadedFiles: [], currentFileId: null, currentFile: null,
        selectedFileIds: [], detectedTracks: [], currentPlayingTrack: null, waveform: null,
        waveformLoading: false, waveformRegions: null, waveformMinimap: null, currentZoom: 50, waveformMode: 'mono', searchQuery: '',
        playing: false, uiScale: parseFloat(localStorage.getItem('uiScale') || '1'),
        ffmpegLines: [], processingStats: null,
        searchResults: [], selectedRelease: null, customMapping: [], searchAbortController: null,
        isProcessing: false, processingProgress: 0, processingMessage: '', successMessage: '',
        processingStage: '', processingJob: { id: '', filename: '', duration: 0, tracks: 0, formats: 0 },
        processingStartTime: null, processingEtaSec: null, processingTick: 0, processingTicker: null,
        processingTracks: [], processingTrackState: {}, processingFormatLabels: {},
        systemMetrics: { cpu_percent: null, ram_used_gb: null, ram_total_gb: null, ram_percent: null, process_rss_mb: null },
        ffmpegStatus: { ok: true, version: '', last_error: '' },
        metricsTimer: null,
        lastProcessedIds: [], outputFormats: ['flac'], availableFormats: [], restorationLevel: 0,
        showQuitModal: false,
        config: { silence_threshold: -40, min_silence_duration: 1.5, output_dir: '', flac_compression: 8, discogs_user_token: '', discogs_user_agent: '' },
        supportedExtensions: ['.wav', '.aiff', '.aif', '.flac', '.mp3'],
        discogsConfigured: true, darkMode: localStorage.getItem('darkMode') !== 'false',
        systemStatus: { ffmpeg_ok: true, data_dir: '', ffmpeg_path: '', ffmpeg_source: '', ffmpeg_fallback: false },
        cueBank: 0,
        maxCues: 16,
        _waveInitToken: 0,
        selectedRegionId: null,
        searchError: '',

        async init() {
            this.updateDarkMode();
            if (!Number.isFinite(this.uiScale) || this.uiScale < 0.5 || this.uiScale > 2.0) {
                this.uiScale = 1;
                localStorage.setItem('uiScale', this.uiScale);
            }
            this.applyUiScale(this.uiScale);
            document.addEventListener('contextmenu', e => { if (!e.target.closest('input, textarea')) e.preventDefault(); }, true);
            await this.loadConfig(); await this.loadFormats(); await this.fetchQueue(); this.connectWebSocket();
            this.checkStatus();
            this.$watch('currentFile', (f) => { if (f && !this.searchQuery) this.searchQuery = this.cleanFilename(f.filename); });
            document.addEventListener('keydown', (e) => this.handleKeydown(e));
        },

        toggleDarkMode() { 
            this.darkMode = !this.darkMode; 
            localStorage.setItem('darkMode', this.darkMode); 
            document.documentElement.classList.toggle('dark', this.darkMode);
            document.body.classList.toggle('dark', this.darkMode);
        },
        updateDarkMode() { 
            document.documentElement.classList.toggle('dark', this.darkMode);
            document.body.classList.toggle('dark', this.darkMode);
        },

        async refreshSystemMetrics() {
            try {
                const res = await fetch('/api/system-metrics');
                const d = await res.json();
                this.systemMetrics = { ...d };
            } catch (e) {}
        },

        startMetricsPolling() {
            if (this.metricsTimer) return;
            this.metricsTimer = setInterval(() => this.refreshSystemMetrics(), 1000);
        },

        stopMetricsPolling() {
            if (this.metricsTimer) clearInterval(this.metricsTimer);
            this.metricsTimer = null;
        },

        startProcessingStage(stage, jobId = '') {
            this.isProcessing = true;
            this.processingStage = stage;
            this.processingStartTime = Date.now();
            this.processingEtaSec = null;
            this.processingTick = Date.now();
            if (!this.processingTicker) {
                this.processingTicker = setInterval(() => { this.processingTick = Date.now(); }, 1000);
            }
            this.refreshSystemMetrics();
            this.startMetricsPolling();
            const file = this.currentFile;
            this.processingJob = {
                id: jobId || stage.toUpperCase(),
                filename: file?.filename || '',
                duration: file?.duration || 0,
                tracks: 0,
                formats: this.outputFormats.length,
            };
        },

        stopProcessingStage() {
            this.isProcessing = false;
            this.processingStage = '';
            this.processingStartTime = null;
            this.processingEtaSec = null;
            if (this.processingTicker) clearInterval(this.processingTicker);
            this.processingTicker = null;
            this.stopMetricsPolling();
        },

        initProcessingTracks(tracks) {
            this.processingTracks = tracks.map(t => ({
                number: t.number,
                vinyl_number: t.vinyl_number || `T${t.number}`,
                title: t.title || '',
                duration: t.duration || (t.end - t.start),
            }));
            this.processingJob.tracks = this.processingTracks.length;
            this.processingTrackState = {};
            this.processingFormatLabels = {};
            this.outputFormats.forEach(fmt => {
                const fmtObj = this.availableFormats.find(f => f.id === fmt);
                this.processingFormatLabels[fmt] = fmtObj ? fmtObj.label : fmt.toUpperCase();
            });
            this.processingTracks.forEach(track => {
                const fmtState = {};
                this.outputFormats.forEach(fmt => { fmtState[fmt] = 'queued'; });
                this.processingTrackState[track.number] = { percent: 0, status: 'queued', formats: fmtState };
            });
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
            this.searchError = '';
            this.processingProgress = 0; this.processingMessage = ''; this.destroyWaveform();
            this.cueBank = 0;
            if (this.currentFile) { this.searchQuery = this.cleanFilename(this.currentFile.filename); if (this.detectedTracks.length > 0) this.initWaveform(); }
        },

        async removeFile(id) {
            if (!confirm('Remove file?')) return;
            try { await fetch(`/api/queue/${id}`, { method: 'DELETE' }); await this.fetchQueue(); } catch (e) {}
        },

        async uploadFiles(files) {
            if (files.length === 0) return;
            const fd = new FormData(); files.forEach(f => fd.append('files', f));
            this.startProcessingStage('uploading');
            this.processingMessage = 'Uploading...';
            try { await fetch('/api/upload', { method: 'POST', body: fd }); await this.fetchQueue(); } catch (e) {}
            finally { this.processingMessage = ''; this.stopProcessingStage(); }
        },

        async mergeFiles() {
            if (this.selectedFileIds.length < 2) return;
            this.startProcessingStage('merging');
            this.processingMessage = 'Merging tracks...';
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
                this.processingMessage = '';
                this.stopProcessingStage();
            }
        },

        async analyzeFileById(id, updateCurrent = false) {
            if (!id) return;
            if (updateCurrent) this.waveformLoading = true;
            if (updateCurrent) {
                if (!this.isProcessing) this.startProcessingStage('analyzing');
                this.processingMessage = 'Analyzing...';
                this.processingProgress = 0.1;
                this.processingJob = {
                    id: 'ANALYZE',
                    filename: this.currentFile?.filename || '',
                    duration: this.currentFile?.duration || 0,
                    tracks: 0,
                    formats: this.outputFormats.length,
                };
            }
            try {
                const r = await fetch('/api/analyze', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({file_id: id}) });
                const d = await r.json();
                const tracks = d.tracks.map(t => ({ ...t, editing: false, ignored: false }));
                const file = this.uploadedFiles.find(f => f.id === id);
                if (file) {
                    file.detected_tracks = tracks;
                    file.status = 'analyzed';
                }
                if (updateCurrent) {
                    this.detectedTracks = tracks;
                    if (!this.searchQuery) this.searchQuery = this.cleanFilename(this.currentFile?.filename || '');
                    await this.initWaveform();
                    if (this.searchQuery) await this.searchDiscogs();
                }
            } catch (e) {
                console.error('Analysis failed:', e);
                if (updateCurrent) alert('Analysis failed. Please check the terminal logs for details.');
            } finally {
                if (updateCurrent) {
                    this.waveformLoading = false;
                    this.processingProgress = 1;
                    this.processingMessage = '';
                    this.stopProcessingStage();
                }
            }
        },

        async analyzeFile() {
            if (!this.currentFileId) return;
            await this.analyzeFileById(this.currentFileId, true);
        },

        async analyzeSelectedFiles() {
            if (this.selectedFileIds.length === 0) { alert('Select files first'); return; }
            this.startProcessingStage('analyzing');
            this.processingJob = {
                id: 'ANALYZE',
                filename: `Batch (${this.selectedFileIds.length} files)`,
                duration: 0,
                tracks: 0,
                formats: this.outputFormats.length,
            };
            const ids = [...this.selectedFileIds];
            try {
                for (let i = 0; i < ids.length; i++) {
                    const id = ids[i];
                    this.processingProgress = i / ids.length;
                    const file = this.uploadedFiles.find(f => f.id === id);
                    const name = file?.filename || 'file';
                    this.processingMessage = `Analyzing ${name}...`;
                    await this.analyzeFileById(id, id === this.currentFileId);
                }
            } finally {
                this.processingProgress = 1;
                this.processingMessage = '';
                this.stopProcessingStage();
            }
        },

        async searchDiscogs() {
            this.searchError = '';
            if (!this.searchQuery.trim()) return;
            if (!this.discogsConfigured) {
                this.searchResults = [];
                this.searchError = 'Discogs is not configured. Open Settings and add a user token.';
                return;
            }
            if (this.searchAbortController) this.searchAbortController.abort();
            this.searchAbortController = new AbortController(); this.searchLoading = true;
            try {
                const r = await fetch('/api/search', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({query: this.searchQuery}), signal: this.searchAbortController.signal });
                const d = await r.json();
                this.searchResults = d.results || [];
                if (!this.searchResults.length) this.searchError = 'No Discogs results found.';
            } catch (e) {} finally { if (!this.searchAbortController.signal.aborted) this.searchLoading = false; }
        },

        selectRelease(r) { 
            this.selectedRelease = r; 
            const tMap = this.allDetectedTracks.filter(t => !t.ignored);
            this.customMapping = Array.from({ length: tMap.length }, (_, i) => i);
            if (this.waveform) this.addTrackRegions();
        },

        handleKeydown(e) {
            if (e.target.closest('input, textarea')) return;
            const key = e.key.toLowerCase();
            if (key === '+' || (e.key === '=' && e.shiftKey)) {
                e.preventDefault();
                return this.zoomIn();
            }
            if (key === '-' || e.key === '_') {
                e.preventDefault();
                return this.zoomOut();
            }
            if (key === 'c' && e.shiftKey) {
                e.preventDefault();
                return this.toggleCueBank();
            }
            if (key === 'c') {
                e.preventDefault();
                return this.addCueAtPlayhead();
            }
            if (/^[1-8]$/.test(key)) {
                e.preventDefault();
                const idx = parseInt(key, 10) - 1;
                const bank = e.shiftKey ? 1 : 0;
                const cue = this.getCueByIndex(bank, idx);
                if (cue) this.jumpToTrack(cue);
            }
        },

        async processFiles() {
            if (!this.currentFileId) { alert('Select a file first'); return; }
            if (!this.selectedRelease) { alert('Select a release first'); return; }
            return this.processFile();
        },

        async processFile() {
            this.startProcessingStage('processing');
            this.processingProgress = 0.02; this.processingMessage = 'Processing...';
            this.lastProcessedIds = [this.currentFileId];
            const active = this.detectedTracks.filter(t => !t.ignored);
            this.initProcessingTracks(active);
            this.processingJob.filename = this.currentFile?.filename || '';
            this.processingJob.duration = this.currentFile?.duration || 0;
            this.processingJob.formats = this.outputFormats.length;
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
            } catch (e) { this.stopProcessingStage(); }
        },

        async multiProcessFiles() {
            this.startProcessingStage('processing');
            this.processingProgress = 0.02; this.processingMessage = 'Processing batch...';
            const mapping = []; const boundsMap = {};
            const processedIds = new Set();
            this.selectedFileIds.forEach(id => {
                const f = this.uploadedFiles.find(x => x.id === id);
                if (f && f.detected_tracks) boundsMap[id] = f.detected_tracks.map(t => ({ number: t.number, start: t.start, end: t.end, duration: t.duration || (t.end-t.start) }));
            });
            this.allDetectedTracks.filter(t => !t.ignored).forEach((t, i) => {
                const dt = this.selectedRelease.tracks[this.customMapping[i] || 0];
                if (dt) {
                    mapping.push({ 
                        source_file_id: t.file_id, 
                        detected: t.number, 
                        discogs: dt.position,
                        title: dt.title 
                    });
                    processedIds.add(t.file_id);
                }
            });
            this.lastProcessedIds = Array.from(processedIds);
            this.initProcessingTracks(this.allDetectedTracks.filter(t => !t.ignored));
            try {
                const res = await fetch('/api/multi-process', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ 
                    release_id: this.selectedRelease.id, track_mapping: mapping, track_boundaries_map: boundsMap, 
                    output_formats: this.outputFormats, restoration_level: this.restorationLevel 
                }) });
                const data = await res.json(); this.startProcessPolling(data.job_id);
            } catch (e) { this.stopProcessingStage(); }
        },

        startProcessPolling(jobId) {
            this.processingJob.id = jobId;
            const timer = setInterval(async () => {
                try {
                    const r = await fetch(`/api/process/${jobId}`); 
                    const j = await r.json();
                    if (j.status === 'processing') { 
                        this.processingMessage = j.message || 'Processing...'; 
                    }
                    else if (j.status === 'complete') {
                        clearInterval(timer);
                        const elapsed = this.processingStartTime ? Math.round((Date.now() - this.processingStartTime) / 1000) : 0;
                        this.processingStats = { tracks: j.tracks ? j.tracks.length : 0, files: j.tracks || [], elapsed, formats: this.outputFormats.length };
                        this.stopProcessingStage();
                        this.successMessage = 'done';
                        this.fetchQueue();
                    }
                    else if (j.status === 'error') { 
                        clearInterval(timer); 
                        this.stopProcessingStage(); 
                        alert('Error: ' + j.error); 
                    }
                } catch (e) {}
            }, 1000);
        },

        handleProgressEvent(d) {
            if (!this.isProcessing) return;
            if (d.progress !== undefined) {
                this.processingProgress = 0 + d.progress;
                if (this.processingStartTime && d.progress > 0.05) {
                    if (!this._etaWindow) this._etaWindow = [];
                    const now = Date.now() / 1000;
                    this._etaWindow.push({ t: now, p: d.progress });
                    if (this._etaWindow.length > 20) this._etaWindow.shift();
                    let eta = null;
                    if (this._etaWindow.length >= 3) {
                        const oldest = this._etaWindow[0];
                        const newest = this._etaWindow[this._etaWindow.length - 1];
                        const dp = newest.p - oldest.p;
                        const dt = newest.t - oldest.t;
                        if (dp > 0.001 && dt > 1) {
                            const speed = dp / dt;
                            const remaining = (1 - d.progress) / speed;
                            eta = remaining > 3 ? remaining : 3;
                        }
                    }
                    this.processingEtaSec = eta;
                }
            }
            if (d.message) this.processingMessage = d.message;

            if (d.stage && d.track && d.format) {
                const trackNum = d.track.number;
                if (!this.processingTrackState[trackNum]) {
                    const fmtState = {};
                    this.outputFormats.forEach(fmt => { fmtState[fmt] = 'queued'; });
                    this.processingTrackState[trackNum] = { percent: 0, status: 'queued', formats: fmtState };
                }
                const state = this.processingTrackState[trackNum];
                if (d.stage === 'track_start') {
                    state.status = 'active';
                    state.formats = { ...state.formats, [d.format]: 'active' };
                } else if (d.stage === 'track_done') {
                    state.formats = { ...state.formats, [d.format]: 'done' };
                    const doneCount = Object.values(state.formats).filter(v => v === 'done').length;
                    state.percent = Math.round((doneCount / this.outputFormats.length) * 100);
                    if (doneCount === this.outputFormats.length) state.status = 'done';
                }
                // Force Alpine reactivity
                this.processingTrackState = { ...this.processingTrackState };
            }
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
            const token = ++this._waveInitToken;
            if (!this.currentFileId) return;
            if (this.waveform) {
                this.destroyWaveform();
                await new Promise(r => setTimeout(r, 50));
            }
            await this.$nextTick();
            await new Promise(r => requestAnimationFrame(r));
            this.waveformLoading = true;
            try {
                this.resetWaveScroll();
                const ws = WaveSurfer.create({ 
                    container: '#waveform', 
                    waveColor: document.body.classList.contains('dark') ? '#2a3a50' : '#475569', 
                    progressColor: '#E5A100', 
                    cursorColor: '#FFFFFF', 
                    cursorWidth: 2,
                    height: 180, 
                    minPxPerSec: this.currentZoom,
                    normalize: true, 
                    interact: true,
                    hideScrollbar: false,
                    dragToSeek: false,
                    autoCenter: true,
                    autoScroll: true,
                    splitChannels: this.waveformMode === 'stereo'
                });
                if (token !== this._waveInitToken) { ws.destroy(); return; }
                this.waveform = ws;
                
                this.waveformRegions = ws.registerPlugin(WaveSurfer.Regions.create());
                if (WaveSurfer.Minimap) {
                    this.waveformMinimap = ws.registerPlugin(
                        WaveSurfer.Minimap.create({
                            container: '#waveform-mini',
                            height: 50,
                            waveColor: 'rgba(148, 163, 184, 0.6)',
                            progressColor: 'rgba(229, 161, 0, 0.7)',
                            cursorColor: 'rgba(255, 255, 255, 0.9)',
                        })
                    );
                }
                
                // Wheel Zoom
                const wfContainer = document.getElementById('waveform');
                if (wfContainer) wfContainer.scrollLeft = 0;
                wfContainer.style.cursor = 'crosshair';
                wfContainer.addEventListener('wheel', (e) => {
                    e.preventDefault();
                    if (e.shiftKey) {
                        wfContainer.scrollLeft += e.deltaY * 3;
                        return;
                    }
                    const rect = wfContainer.getBoundingClientRect();
                    const mouseRel = (e.clientX - rect.left + wfContainer.scrollLeft) / (wfContainer.scrollWidth || 1);
                    const oldZoom = this.currentZoom;
                    if (e.deltaY < 0) this.currentZoom = Math.min(this.currentZoom * 1.25, 500);
                    else this.currentZoom = Math.max(5, this.currentZoom / 1.25);
                    this.waveform.zoom(this.currentZoom);
                    requestAnimationFrame(() => {
                        wfContainer.scrollLeft = mouseRel * wfContainer.scrollWidth - (e.clientX - rect.left);
                    });
                }, { passive: false });

                // Left: klik = seek, drag = scrub (niet op regio-handles)
                let _scrubActive = false, _scrubStartX = 0;
                wfContainer.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    if (e.target.closest('.wavesurfer-handle')) return; // regio handles: niet onderscheppen
                    _scrubStartX = e.clientX;
                    _scrubActive = false;
                    const onMove = (ev) => {
                        if (Math.abs(ev.clientX - _scrubStartX) > 5) {
                            _scrubActive = true;
                            const dur = this.waveform.getDuration();
                            const absX = ev.clientX - wfContainer.getBoundingClientRect().left + wfContainer.scrollLeft;
                            const t = (absX / wfContainer.scrollWidth) * dur;
                            this.waveform.setTime(Math.max(0, Math.min(t, dur)));
                        }
                    };
                    const onUp = (ev) => {
                        window.removeEventListener('mousemove', onMove);
                        window.removeEventListener('mouseup', onUp);
                        if (!_scrubActive) {
                            // Gewone klik: seek + deselect regio
                            const dur = this.waveform.getDuration();
                            const absX = ev.clientX - wfContainer.getBoundingClientRect().left + wfContainer.scrollLeft;
                            const t = (absX / wfContainer.scrollWidth) * dur;
                            this.waveform.setTime(Math.max(0, Math.min(t, dur)));
                            if (!ev.target.closest('.wavesurfer-region')) {
                                this.selectedRegionId = null;
                                this.addTrackRegions();
                            }
                        }
                    };
                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                });

                // No context menu
                wfContainer.oncontextmenu = (e) => e.preventDefault();

                const p = await (await fetch(`/api/waveform-peaks/${this.currentFileId}`)).json();
                if (token !== this._waveInitToken) { ws.destroy(); return; }
                ws.load(`/api/audio/${this.currentFileId}`, p.peaks);
                
                ws.once('ready', async () => {
                    await this.$nextTick();
                    await new Promise(r => requestAnimationFrame(r));
                    this.resetWaveScroll();
                    this.waveform.seekTo(0);
                    this.addTrackRegions();
                    this.waveformLoading = false;
                    this.waveform.zoom(this.currentZoom);
                    if (typeof this.drawTimeRuler === 'function') this.drawTimeRuler();
                    this.startRulerSync();
                });
                ws.on('play',   () => { this.playing = true; });
                ws.on('pause',  () => { this.playing = false; });
                ws.on('finish', () => { this.playing = false; });

                this.waveformRegions.on('region-clicked', (region, e) => {
                    this.selectedRegionId = region.id;
                    this.addTrackRegions();
                    // Let the waveform 'click' event handle the playhead positioning
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

        drawTimeRuler() {
            const canvas = document.getElementById('time-ruler');
            if (!canvas || !this.waveform) return;
            const wfEl = document.getElementById('waveform');
            if (!wfEl) return;
            const scrollLeft = wfEl.scrollLeft;
            const scrollWidth = wfEl.scrollWidth;
            const viewWidth = wfEl.clientWidth;
            const duration = this.waveform.getDuration();
            if (!duration) return;

            const dpr = window.devicePixelRatio || 1;
            canvas.width = viewWidth * dpr;
            canvas.height = 24 * dpr;
            canvas.style.width = viewWidth + 'px';
            canvas.style.height = '24px';

            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, viewWidth, 24);

            const dark = document.body.classList.contains('dark');
            const tickColor = dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)';
            const labelColor = dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)';
            const amberColor = '#E5A100';

            const pxPerSec = scrollWidth / duration;
            let majorInterval = 60;
            let minorInterval = 10;
            if (pxPerSec > 80) { majorInterval = 10; minorInterval = 1; }
            else if (pxPerSec > 20) { majorInterval = 30; minorInterval = 5; }
            else if (pxPerSec > 8) { majorInterval = 60; minorInterval = 10; }
            else { majorInterval = 120; minorInterval = 30; }

            const startSec = (scrollLeft / scrollWidth) * duration;
            const endSec = ((scrollLeft + viewWidth) / scrollWidth) * duration;

            ctx.font = '9px monospace';
            ctx.textBaseline = 'top';

            for (let t = Math.floor(startSec / minorInterval) * minorInterval; t <= endSec + minorInterval; t += minorInterval) {
                const x = ((t / duration) * scrollWidth - scrollLeft);
                if (x < 0 || x > viewWidth) continue;
                const isMajor = t % majorInterval === 0;
                ctx.strokeStyle = isMajor ? amberColor : tickColor;
                ctx.lineWidth = isMajor ? 1.5 : 0.8;
                ctx.beginPath();
                ctx.moveTo(x, isMajor ? 2 : 10);
                ctx.lineTo(x, 24);
                ctx.stroke();
                if (isMajor) {
                    const mins = Math.floor(t / 60);
                    const secs = Math.floor(t % 60);
                    const label = mins > 0 ? `${mins}:${String(secs).padStart(2,'0')}` : `${secs}s`;
                    ctx.fillStyle = labelColor;
                    ctx.fillText(label, x + 3, 2);
                }
            }
        },

        resetWaveScroll() {
            const host = document.getElementById('waveform');
            const wrap = document.querySelector('.wave-main-wrap');
            if (host) host.scrollLeft = 0;
            if (wrap) wrap.scrollLeft = 0;
        },

        startRulerSync() {
            if (this._rulerRaf) return;
            const tick = () => {
                if (!this.waveform) { this._rulerRaf = null; return; }
                if (this.playing && typeof this.drawTimeRuler === 'function') {
                    try { this.drawTimeRuler(); } catch (e) {}
                }
                this._rulerRaf = setTimeout(tick, this.playing ? 16 : 250);
            };
            this._rulerRaf = setTimeout(tick, 250);
        },

        addManualTrack(startTime) {
            // startTime is provided by waveform.getCurrentTime()
            if (this.detectedTracks.length >= this.maxCues) {
                alert(`Max ${this.maxCues} hotcues reached.`);
                return;
            }
            const num = this.detectedTracks.length + 1;
            const duration = this.waveform.getDuration();
            const endTime = Math.min(startTime + 30, duration);
            const newTrack = { number: num, start: startTime, end: endTime, duration: endTime - startTime };
            this.detectedTracks.push(newTrack);
            this.detectedTracks.sort((a,b) => a.start - b.start).forEach((t, i) => t.number = i + 1);
            this.selectedRegionId = `track-${newTrack.number}`;
            this.addTrackRegions();
            return newTrack;
        },

        addCueAtPlayhead() {
            if (!this.waveform) return;
            this.addManualTrack(this.waveform.getCurrentTime());
        },

        setCueAtPlayhead(slotNumber) {
            if (!this.waveform) return;
            const currentTime = this.waveform.getCurrentTime();
            const duration = this.waveform.getDuration();
            const existing = this.detectedTracks.find(t => t.number === slotNumber);
            if (existing) {
                const length = existing.duration || (existing.end - existing.start) || 30;
                existing.start = currentTime;
                existing.end = Math.min(duration, currentTime + length);
                existing.duration = existing.end - existing.start;
                this.selectedRegionId = `track-${existing.number}`;
                this.addTrackRegions();
                return;
            }
            const newTrack = this.addManualTrack(currentTime);
            if (newTrack) this.selectedRegionId = `track-${newTrack.number}`;
        },

        removeCueByNumber(slotNumber) {
            const idx = this.detectedTracks.findIndex(t => t.number === slotNumber);
            if (idx === -1) return;
            this.detectedTracks.splice(idx, 1);
            this.detectedTracks.sort((a,b) => a.start - b.start).forEach((t, i) => t.number = i + 1);
            this.selectedRegionId = null;
            this.addTrackRegions();
        },

        toggleCueBank() {
            this.cueBank = this.cueBank === 0 ? 1 : 0;
        },

        getCueByIndex(bank, idx) {
            const sorted = [...this.detectedTracks].sort((a, b) => a.number - b.number);
            const cue = sorted[(bank * 8) + idx];
            return cue || null;
        },

        increaseUiScale() { this.applyUiScale(this.uiScale + 0.1); },
        decreaseUiScale() { this.applyUiScale(this.uiScale - 0.1); },
        applyUiScale(v) {
            const parsed = parseFloat(v);
            const fallbackScale = Number.isFinite(this.uiScale) ? this.uiScale : 1;
            const nextScale = Number.isFinite(parsed) ? parsed : fallbackScale;
            this.uiScale = Math.min(2.0, Math.max(0.5, nextScale));
            localStorage.setItem('uiScale', this.uiScale);
            document.body.style.zoom = this.uiScale;
        },

        zoomIn() {
            if (!this.waveform) return;
            this.currentZoom = Math.min(this.currentZoom * 1.25, 500);
            this.waveform.zoom(this.currentZoom);
        },

        zoomOut() {
            if (!this.waveform) return;
            this.currentZoom = Math.max(1, this.currentZoom / 1.25);
            this.waveform.zoom(this.currentZoom);
        },

        resetZoom() {
            if (!this.waveform) return;
            this.currentZoom = 50;
            this.waveform.zoom(this.currentZoom);
        },

        toggleWaveformMode() {
            this.waveformMode = this.waveformMode === 'mono' ? 'stereo' : 'mono';
            this.destroyWaveform();
            this.initWaveform();
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
            const colors = [
                'rgba(245, 166, 35, 0.35)',
                'rgba(80, 170, 255, 0.35)',
                'rgba(46, 204, 113, 0.35)',
                'rgba(155, 89, 182, 0.35)',
                'rgba(231, 76, 60, 0.35)',
                'rgba(241, 196, 15, 0.35)',
                'rgba(26, 188, 156, 0.35)',
                'rgba(255, 126, 179, 0.35)',
            ];
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

        jumpToTrack(t) { 
            if (!t) return;
            this.selectedRegionId = `track-${t.number}`;
            this.addTrackRegions();
            if (this.waveform) { 
                this.waveform.setTime(t.start); 
                this.waveform.play(); 
            } 
        },

        // ── Cue row helpers ─────────────────────────────────────────────────
        cueRowAction(slotNumber) {
            const cue = this.detectedTracks.find(t => t.number === slotNumber);
            if (cue) {
                this.selectCue(cue);
            } else {
                this.setCueAtPlayhead(slotNumber);
            }
        },

        getCueDisplayTitle(cue) {
            if (!cue) return '';
            if (cue.title) return cue.title;
            return '';
        },

        setCueTime(cue, field, value) {
            if (!cue) return;
            value = (value || '').trim();
            let secs = 0;
            if (value.includes(':')) {
                const parts = value.split(':');
                secs = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
            } else { secs = parseFloat(value); }
            if (isNaN(secs) || secs < 0) return;
            const dur = this.waveform ? this.waveform.getDuration() : 9999;
            if (field === 'start') {
                cue.start = Math.min(secs, cue.end - 0.5);
            } else {
                cue.end = Math.min(Math.max(secs, cue.start + 0.5), dur);
            }
            cue.duration = cue.end - cue.start;
            this.addTrackRegions();
        },

        selectCue(t) {
            if (!t) return;
            this.selectedRegionId = `track-${t.number}`;
            this.addTrackRegions();
            if (this.waveform) this.waveform.setTime(t.start);
        },
        playWaveform()  { if (this.waveform) { this.waveform.play();  this.playing = true;  } },
        pauseWaveform() { if (this.waveform) { this.waveform.pause(); this.playing = false; } },
        stopWaveform()  { if (this.waveform) { this.waveform.pause(); this.waveform.setTime(0); this.playing = false; } },
        skipToStart()   { if (this.waveform) this.waveform.setTime(0); },
        skipToEnd()     { if (this.waveform) this.waveform.setTime(this.waveform.getDuration()); },

        _seekTimer: null, _seekAccel: null,
        startSeek(dir) {
            this._seekSpeed = 2;
            this._seekDir = dir;
            this._doSeekStep();
            this._seekAccel = setInterval(() => { this._seekSpeed = Math.max(0.05, this._seekSpeed * 0.82); }, 350);
            this._seekTimer = setInterval(() => this._doSeekStep(), 80);
        },
        _doSeekStep() {
            if (!this.waveform) return;
            const t = this.waveform.getCurrentTime() + this._seekDir * this._seekSpeed;
            this.waveform.setTime(Math.max(0, Math.min(t, this.waveform.getDuration())));
        },
        stopSeek() {
            clearInterval(this._seekTimer);
            clearInterval(this._seekAccel);
            this._seekTimer = null;
        },
        destroyWaveform() {
            if (this._rulerRaf) {
                clearTimeout(this._rulerRaf);
                this._rulerRaf = null;
            }
            this.waveform?.destroy();
            this.waveform = null;
            this.waveformRegions = null;
            this.waveformMinimap = null;
            this.resetWaveScroll();
        },

        async loadConfig() { 
            try { 
                this.config = await (await fetch('/api/config')).json();
                // Apply defaults if they exist
                if (this.config.default_output_formats) this.outputFormats = this.config.default_output_formats;
                if (this.config.default_restoration_level !== undefined) this.restorationLevel = this.config.default_restoration_level;
            } catch(e){} 
        },
        async loadFormats() { try { this.availableFormats = (await (await fetch('/api/formats')).json()).formats; } catch(e){} },
        async saveConfig() { 
            await fetch('/api/config', { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(this.config) }); 
            await this.checkStatus();
            this.showSettings = false; 
        },
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
        async chooseOutputFolder() {
            try {
                if (window.pywebview && window.pywebview.api && window.pywebview.api.select_output_folder) {
                    const path = await window.pywebview.api.select_output_folder(this.config.output_dir || '');
                    if (path) { this.config.output_dir = path; return; }
                }
            } catch (e) {}
            const r = await fetch('/api/utils/select-folder', { method: 'POST' });
            const d = await r.json();
            if (d.path) this.config.output_dir = d.path;
        },
        async checkStatus() { 
            try { 
                const r = await fetch('/api/status'); 
                const d = await r.json(); 
                this.discogsConfigured = d.discogs_configured;
                this.systemStatus = d;
                this.ffmpegStatus = { ok: d.ffmpeg_ok, version: d.ffmpeg_version, last_error: d.ffmpeg_last_error };
            } catch(e){} 
        },

        async quitApp(clearQueue = false) {
            try {
                fetch('/api/quit', { 
                    method: 'POST', 
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ clear_queue: clearQueue })
                });
                setTimeout(() => { window.close(); }, 500);
            } catch(e) { window.close(); }
        },

        handleDrop(e) { this.dragging = false; this.uploadFiles(Array.from(e.dataTransfer.files).filter(f => this.isSupportedFile(f.name))); },
        handleFileSelect(e) { this.uploadFiles(Array.from(e.target.files)); },
        isSupportedFile(f) { return this.supportedExtensions.includes(f.toLowerCase().substring(f.lastIndexOf('.'))); },
        
        selectAllFiles() { this.selectedFileIds = this.uploadedFiles.map(f => f.id); },
        deselectAllFiles() { this.selectedFileIds = []; },
        toggleFileSelection(id) { if (this.selectedFileIds.includes(id)) this.selectedFileIds = this.selectedFileIds.filter(x => x !== id); else { this.selectedFileIds.push(id); this.selectFile(id); } },

        get showMergeButton() {
            if (this.selectedFileIds.length <= 1) return false;
            const selected = this.selectedFileIds.map(id => this.uploadedFiles.find(f => f.id === id)).filter(Boolean);
            if (selected.length === 0) return false;
            return !selected.every(f => f.detected_tracks && f.detected_tracks.length);
        },

        get allDetectedTracks() {
            let tracks = [];
            this.selectedFileIds.forEach(id => {
                const file = this.uploadedFiles.find(f => f.id === id);
                if (file && file.detected_tracks) file.detected_tracks.forEach(t => tracks.push({ ...t, file_id: id, filename: file.filename }));
            });
            if (tracks.length === 0 && this.detectedTracks.length > 0) return this.detectedTracks.map(t => ({ ...t, file_id: this.currentFileId, filename: this.currentFile?.filename }));
            return tracks;
        },

        get visibleCues() {
            const sorted = [...this.detectedTracks].sort((a, b) => a.number - b.number);
            const start = this.cueBank * 8;
            return sorted.slice(start, start + 8);
        },

        get cueSlotsA() {
            return Array.from({ length: 8 }, (_, idx) => {
                const slotNumber = idx + 1;
                const cue = this.detectedTracks.find(t => t.number === slotNumber) || null;
                return { slotNumber, cue, idx };
            });
        },
        get cueSlotsB() {
            return Array.from({ length: 8 }, (_, idx) => {
                const slotNumber = idx + 9;
                const cue = this.detectedTracks.find(t => t.number === slotNumber) || null;
                return { slotNumber, cue, idx };
            });
        },
        get cueSlots() { return [...this.cueSlotsA, ...this.cueSlotsB]; },

        get nextFileName() {
            if (!this.uploadedFiles.length) return '';
            const remaining = this.uploadedFiles.filter(f => f.id !== this.currentFileId);
            return remaining.length ? remaining[0].filename : '';
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
                if (e.data === 'pong') return;
                try {
                    const d = JSON.parse(e.data);
                    if (d.type === 'progress') {
                        this.handleProgressEvent(d);
                        if (d.message) {
                            const lines = [...(this.ffmpegLines || []), d.message];
                            this.ffmpegLines = lines.length > 8 ? lines.slice(-8) : lines;
                        }
                    } else if (d.type === 'complete' && (d.file_id === this.currentFileId || d.file_id === 'multi')) {
                        const elapsed = this.processingStartTime ? Math.round((Date.now() - this.processingStartTime) / 1000) : 0;
                        this.processingStats = { tracks: d.tracks ? d.tracks.length : 0, files: d.tracks || [], elapsed, formats: this.outputFormats.length };
                        this.stopProcessingStage();
                        this.successMessage = 'done';
                    }
                } catch (err) {}
            };
            ws.onclose = () => setTimeout(() => this.connectWebSocket(), 3000);
        },

        cleanFilename(f) { return f.replace(/\.(wav|aiff|aif|flac|mp3)$/i, "").replace(/[-_]+/g, ' ').trim(); },
        formatSize(b) { if(!b) return '0 B'; const k=1024, s=['B','KB','MB','GB'], i=Math.floor(Math.log(b)/Math.log(k)); return (b/Math.pow(k,i)).toFixed(2)+' '+s[i]; },
        formatDuration(s) { if(!s) return '0:00'; return Math.floor(s/60)+':'+Math.floor(s%60).toString().padStart(2,'0'); }
    };
}
