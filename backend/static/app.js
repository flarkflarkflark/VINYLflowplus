/**
 * VINYLflowplus Frontend Application
 * Multi-Format Edition
 */

function vinylApp() {
    return {
        ws: null, dragging: false, showSettings: false, uploadProgress: 0, searchLoading: false,
        trackCountMismatch: false, uploadedFiles: [], currentFileId: null, currentFile: null,
        selectedFileIds: [], detectedTracks: [], currentPlayingTrack: null, waveform: null,
        waveformLoading: false, waveformRegions: null, waveformMinimap: null, currentZoom: 1, userZoomed: false, waveformMode: 'mono', searchQuery: '',
        playing: false, waveCurrentTime: 0, waveCurrentTrackName: '', waveCurrentTrackColor: '', vuLevel: 0, waveVolume: 1, timeDisplayMode: 0, _vuRaf: null, _vuAnalyser: null, _vuCtx: null,
        uiScale: parseFloat(localStorage.getItem('uiScale') || '1'),
        ffmpegLines: [], processingStats: null,
        searchResults: [], selectedRelease: null, customMapping: [], searchAbortController: null,
        isProcessing: false, processingProgress: 0, processingMessage: '', successMessage: '',
        processingStage: '', processingJobStatus: '', processingCancelRequested: false, processingCancelled: false,
        processingJob: { id: '', filename: '', duration: 0, tracks: 0, formats: 0 },
        processingStartTime: null, processingEtaSec: null, processingTick: 0, processingTicker: null,
        processingTracks: [], processingTrackState: {}, processingFormatLabels: {},
        processingCurrentTrackNumber: null, processingCurrentTrackTitle: '', processingCurrentTrackVinyl: '', processingCurrentTrackArtist: '',
        processingCurrentFormatLabel: '',
        processingStepBase: null, processingStepSpan: null,
        systemMetrics: { cpu_percent: null, ram_used_gb: null, ram_total_gb: null, ram_percent: null, process_rss_mb: null },
        ffmpegStatus: { ok: true, version: '', last_error: '' },
        appVersion: '',
        metricsTimer: null,
        processPollTimer: null,
        processPollTick: 0,
        lastProgressUpdate: 0,
        lastProcessedIds: [], outputFormats: ['flac'], availableFormats: [], restorationLevel: 0,
        showQuitModal: false,
        successType: '',
        config: { silence_threshold: -40, min_silence_duration: 1.5, output_dir: '', flac_compression: 8, discogs_user_token: '', discogs_user_agent: '' },
        supportedExtensions: ['.wav', '.aiff', '.aif', '.flac', '.mp3'],
        discogsConfigured: true, darkMode: localStorage.getItem('darkMode') !== 'false',
        systemStatus: { ffmpeg_ok: true, data_dir: '', ffmpeg_path: '', ffmpeg_source: '', ffmpeg_fallback: false },
        cueBank: 0,
        maxCues: 32,
        _waveInitToken: 0,
        selectedRegionId: null,
        searchError: '',
        undoStack: [],

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
        get trackGrid() {
            const all = (this.detectedTracks || []).map((track, index) => ({ track, index }));
            const mid = Math.ceil(all.length / 2);
            const left = all.slice(0, mid);
            const right = all.slice(mid);
            const ordered = [];
            for (let i = 0; i < left.length; i++) {
                ordered.push(left[i]);
                if (right[i]) ordered.push(right[i]);
            }
            return ordered;
        },

        startProcessingStage(stage, jobId = '') {
            this.isProcessing = true;
            this.processingStage = stage;
            this.processingJobStatus = stage;
            this.processingCancelRequested = false;
            this.processingCancelled = false;
            this.successMessage = '';
            this.successType = '';
            this.processingStartTime = Date.now();
            this.processingEtaSec = null;
            this.processingTick = Date.now();
            this.processingCurrentTrackNumber = null;
            this.processingCurrentTrackTitle = '';
            this.processingCurrentTrackVinyl = '';
            this.processingCurrentFormatLabel = '';
            this.processingStepBase = null;
            this.processingStepSpan = null;
            this.processingTracks = [];
            this.processingTrackState = {};
            if (!this.processingTicker) {
                this.processingTicker = setInterval(() => {
                    this.processingTick = Date.now();
                    this.updateInterpolatedProgress();
                }, 500);
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
            this.processingJobStatus = '';
            this.processingCancelRequested = false;
            this.processingCancelled = false;
            this.processingStartTime = null;
            this.processingEtaSec = null;
            this.processingCurrentTrackNumber = null;
            this.processingCurrentTrackTitle = '';
            this.processingCurrentTrackVinyl = '';
            this.processingCurrentTrackArtist = '';
            this.processingCurrentFormatLabel = '';
            this.processingStepBase = null;
            this.processingStepSpan = null;
            if (this.processingTicker) clearInterval(this.processingTicker);
            this.processingTicker = null;
            this.stopProcessPolling();
            this.stopMetricsPolling();
        },

        initProcessingTracks(tracks) {
            this.processingTracks = tracks.map(t => ({
                number: t.number,
                vinyl_number: t.vinyl_number || '',
                title: t.title || '',
                artist: t.artist || '',
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
                this.processingTrackState[track.number] = { percent: 0, status: 'queued', formats: fmtState, startAt: null, duration: track.duration || 0 };
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
            this.processingTracks = []; this.processingTrackState = {};
            this.processingProgress = 0; this.processingMessage = ''; this.destroyWaveform();
            this.cueBank = 0;
            if (this.currentFile) { this.searchQuery = this.cleanFilename(this.currentFile.filename); if (this.detectedTracks.length > 0) this.initWaveform(); }
        },

        async removeFile(id) {
            if (!confirm('Remove file?')) return;
            try {
                await fetch(`/api/queue/${id}`, { method: 'DELETE' });
                if (this.currentFileId === id) {
                    this.currentFileId = null;
                    this.currentFile = null;
                    this.detectedTracks = [];
                    this.searchResults = [];
                    this.selectedRelease = null;
                    this.destroyWaveform();
                }
                await this.fetchQueue();
            } catch (e) {}
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
                this.processingProgress = 0.05;
                this.processingJob = {
                    id: 'ANALYZE',
                    filename: this.currentFile?.filename || '',
                    duration: this.currentFile?.duration || 0,
                    tracks: 0,
                    formats: this.outputFormats.length,
                };
                // Interpolate progress during analysis based on file duration
                const analyzeStart = Date.now();
                const analyzeDuration = (this.currentFile?.duration || 120) * 1000;
                // ffmpeg silence detection runs roughly at 8-12x realtime; use 10x as estimate
                const estimatedMs = analyzeDuration / 10;
                if (this._analyzeTicker) clearInterval(this._analyzeTicker);
                this._analyzeTicker = setInterval(() => {
                    const elapsed = Date.now() - analyzeStart;
                    // Asymptotic curve: approaches 0.92 but never reaches it
                    const fraction = 1 - Math.exp(-3 * elapsed / estimatedMs);
                    this.processingProgress = 0.05 + fraction * 0.87;
                }, 200);
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
                    if (this._analyzeTicker) { clearInterval(this._analyzeTicker); this._analyzeTicker = null; }
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
            this.saveUndo();
            this.selectedRelease = r;
            const tMap = this.allDetectedTracks.filter(t => !t.ignored);
            this.customMapping = Array.from({ length: tMap.length }, (_, i) => i);
            // Auto-fill titles, artists, and vinyl positions from Discogs release
            tMap.forEach((t, i) => {
                const dt = r.tracks[this.customMapping[i]];
                if (!dt) return;
                // Write back onto the live detectedTracks entry (same object reference)
                const live = this.detectedTracks.find(x => x.number === t.number);
                if (live) {
                    live.title = dt.title || '';
                    live.artist = dt.artist || '';
                    live.vinyl_number = dt.position || '';
                }
            });
            if (this.waveform) this.addTrackRegions();
        },

        saveUndo() {
            this.undoStack.push(JSON.stringify(this.detectedTracks));
            if (this.undoStack.length > 40) this.undoStack.shift();
        },

        undo() {
            if (!this.undoStack.length) return;
            this.detectedTracks = JSON.parse(this.undoStack.pop());
            this.addTrackRegions();
        },

        handleKeydown(e) {
            const key = e.key.toLowerCase();
            if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.shiftKey && !e.target.closest('input, textarea')) {
                e.preventDefault();
                return this.undo();
            }
            if (e.target.closest('input, textarea')) return;
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
            if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key) && this.selectedRegionId) {
                e.preventDefault();
                const step = e.shiftKey ? 1 : 0.1;
                if (key === 'arrowleft') return this.nudgeSelectedCue(-step, -step);
                if (key === 'arrowright') return this.nudgeSelectedCue(step, step);
                if (key === 'arrowup') return this.nudgeCueLength(step);
                if (key === 'arrowdown') return this.nudgeCueLength(-step);
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
            this.processingJob.filename = this.currentFile?.filename || '';
            this.processingJob.duration = this.currentFile?.duration || 0;
            this.processingJob.formats = this.outputFormats.length;
            const mapping = active.map((t, i) => {
                const discogsTrack = this.selectedRelease.tracks[this.customMapping[this.detectedTracks.indexOf(t)]];
                return {
                    detected: t.number,
                    discogs: discogsTrack?.position || '?',
                    title: discogsTrack?.title || '',
                    artist: discogsTrack?.artist || ''
                };
            });
            this.initProcessingTracks(active.map((t, i) => ({ ...t, vinyl_number: mapping[i]?.discogs || '', title: mapping[i]?.title || '', artist: mapping[i]?.artist || '' })));
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
                        title: dt.title,
                        artist: dt.artist || ''
                    });
                    processedIds.add(t.file_id);
                }
            });
            this.lastProcessedIds = Array.from(processedIds);
            this.initProcessingTracks(this.allDetectedTracks.filter(t => !t.ignored).map(t => {
                const m = mapping.find(x => x.detected === t.number && x.source_file_id === t.file_id);
                return { ...t, vinyl_number: m?.discogs || '', title: m?.title || t.title || '', artist: m?.artist || '' };
            }));
            try {
                const res = await fetch('/api/multi-process', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ 
                    release_id: this.selectedRelease.id, track_mapping: mapping, track_boundaries_map: boundsMap, 
                    output_formats: this.outputFormats, restoration_level: this.restorationLevel 
                }) });
                const data = await res.json(); this.startProcessPolling(data.job_id);
            } catch (e) { this.stopProcessingStage(); }
        },

        async requestCancel() {
            if (!this.canCancelProcessing) return;
            this.processingCancelRequested = true;
            this.processingJobStatus = 'cancelling';
            this.processingMessage = 'Cancelling...';
            try {
                await fetch(`/api/process/${this.processingJob.id}/cancel`, { method: 'POST' });
            } catch (e) {
                this.processingCancelRequested = false;
            }
        },

        markTracksCancelled() {
            Object.keys(this.processingTrackState).forEach((key) => {
                const state = this.processingTrackState[key];
                if (!state) return;
                if (!['done', 'error', 'failed'].includes(state.status)) {
                    state.status = 'cancelled';
                }
                if (state.formats) {
                    Object.keys(state.formats).forEach(fmt => {
                        if (!['done'].includes(state.formats[fmt])) state.formats[fmt] = 'cancelled';
                    });
                }
            });
            this.processingTrackState = { ...this.processingTrackState };
        },

        startProcessPolling(jobId) {
            this.processingJob.id = jobId;
            this.processingJobStatus = 'processing';
            this.stopProcessPolling();
            this.processPollTick = 0;
            this.lastProgressUpdate = 0;
            this.processPollTimer = setInterval(async () => {
                try {
                    const r = await fetch(`/api/process/${jobId}`); 
                    const j = await r.json();
                    if (j.status === 'processing') { 
                        this.processingJobStatus = 'processing';
                        this.processingMessage = j.message || 'Processing...'; 
                        if (j.updated_at && j.updated_at !== this.lastProgressUpdate) {
                            this.lastProgressUpdate = j.updated_at;
                            this.handleProgressEvent({
                                progress: j.progress,
                                message: j.message,
                                stage: j.stage,
                                track: j.track,
                                format: j.format,
                                track_index: j.track_index,
                                track_total: j.track_total,
                                format_label: j.format_label,
                                format_index: j.format_index,
                                format_total: j.format_total,
                            });
                        } else if (j.progress !== undefined) {
                            this.processingProgress = Math.max(this.processingProgress, j.progress);
                        }
                        this.processPollTick = (this.processPollTick || 0) + 1;
                        if (this.processPollTick % 4 === 0) {
                            this.fetchQueue();
                        }
                    }
                    else if (j.status === 'cancelling') {
                        this.processingJobStatus = 'cancelling';
                        this.processingCancelRequested = true;
                        this.processingStage = j.stage || 'cancelling';
                        this.processingMessage = j.message || 'Cancelling...';
                        if (j.progress !== undefined) this.processingProgress = Math.max(this.processingProgress, j.progress);
                    }
                    else if (j.status === 'cancelled') {
                        this.processingJobStatus = 'cancelled';
                        this.processingCancelled = true;
                        this.processingCancelRequested = false;
                        this.processingStage = j.stage || 'cancelled';
                        this.processingMessage = j.message || 'Cancelled';
                        if (j.progress !== undefined) this.processingProgress = 0 + j.progress;
                        this.markTracksCancelled();
                        this.stopProcessPolling();
                        this.stopMetricsPolling();
                        this.successType = 'cancelled';
                        this.successMessage = 'Cancelled';
                        this.stopProcessingStage();
                        this.fetchQueue();
                    }
                    else if (j.status === 'complete') {
                        this.processingJobStatus = 'complete';
                        this.stopProcessPolling();
                        const elapsed = this.processingStartTime ? Math.round((Date.now() - this.processingStartTime) / 1000) : 0;
                        this.processingStats = { tracks: j.tracks ? j.tracks.length : 0, files: j.tracks || [], elapsed, formats: this.outputFormats.length, output_folder: j.output_folder || '' };
                        this.stopProcessingStage();
                        this.successType = 'success';
                        this.successMessage = 'done';
                        this.fetchQueue();
                    }
                    else if (j.status === 'error') { 
                        this.processingJobStatus = 'error';
                        this.stopProcessPolling(); 
                        this.stopProcessingStage(); 
                        alert('Error: ' + j.error); 
                    }
                } catch (e) {}
            }, 500);
        },

        handleProgressEvent(d) {
            if (!this.isProcessing) return;
            if (d.stage) {
                this.processingStage = d.stage;
            }
            if (d.track_total !== undefined || d.track_index !== undefined || d.format_index !== undefined) {
                this.processingJob = {
                    ...this.processingJob,
                    track_index: d.track_index ?? this.processingJob.track_index ?? 0,
                    track_total: d.track_total ?? this.processingJob.track_total ?? 0,
                    format_index: d.format_index ?? this.processingJob.format_index ?? 0,
                    format_total: d.format_total ?? this.processingJob.format_total ?? 0,
                };
            }
            if (d.track) {
                this.processingCurrentTrackNumber = d.track.number ?? this.processingCurrentTrackNumber;
                this.processingCurrentTrackTitle = d.track.title || this.processingCurrentTrackTitle;
                this.processingCurrentTrackVinyl = d.track.vinyl_number || this.processingCurrentTrackVinyl;
                this.processingCurrentTrackArtist = d.track.artist || this.processingCurrentTrackArtist;
            }
            if (d.format_label) {
                this.processingCurrentFormatLabel = d.format_label;
            }
            if (d.progress !== undefined) {
                this.processingProgress = Math.max(this.processingProgress, d.progress);
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
                    const trackObj = this.processingTracks.find(t => t.number === trackNum);
                    this.processingTrackState[trackNum] = { percent: 0, status: 'queued', formats: fmtState, startAt: null, duration: trackObj?.duration || 0 };
                }
                const state = this.processingTrackState[trackNum];
                if (d.stage === 'track_start') {
                    state.status = 'active';
                    state.formats = { ...state.formats, [d.format]: 'active' };
                    state.startAt = Date.now();
                    if (d.track_total && d.format_total && d.track_index && d.format_index) {
                        const totalSteps = d.track_total * d.format_total;
                        const stepIndex = (d.format_index - 1) * d.track_total + (d.track_index - 1);
                        this.processingStepSpan = totalSteps ? (0.8 / totalSteps) : null;
                        this.processingStepBase = totalSteps ? (0.1 + stepIndex * this.processingStepSpan) : null;
                    }
                } else if (d.stage === 'track_done') {
                    state.formats = { ...state.formats, [d.format]: 'done' };
                    const doneCount = Object.values(state.formats).filter(v => v === 'done').length;
                    state.percent = Math.round((doneCount / this.outputFormats.length) * 100);
                    if (doneCount === this.outputFormats.length) state.status = 'done';
                    state.startAt = null;
                    this.processingStepBase = d.progress ?? this.processingStepBase;
                }
                // Force Alpine reactivity
                this.processingTrackState = { ...this.processingTrackState };
            }
        },

        updateInterpolatedProgress() {
            if (!this.isProcessing) return;
            const active = this.activeProcessingTrack;
            if (!active) return;
            const state = this.processingTrackState[active.number];
            if (!state || !state.startAt) return;
            const durationSec = state.duration || active.duration || 0;
            const elapsedSec = (Date.now() - state.startAt) / 1000;
            let fraction = 0;
            if (durationSec > 1) {
                fraction = Math.min(elapsedSec / durationSec, 0.98);
            } else {
                const cycle = (Date.now() - state.startAt) % 3500;
                fraction = 0.2 + (cycle / 3500) * 0.7;
            }
            state.percent = Math.max(state.percent || 0, Math.floor(fraction * 100));
            this.processingTrackState = { ...this.processingTrackState };
            if (this.processingStepBase !== null && this.processingStepSpan) {
                const progress = this.processingStepBase + this.processingStepSpan * fraction;
                if (progress > this.processingProgress) this.processingProgress = progress;
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
                if (!this.userZoomed) {
                    const cueZoom = this.computeCueZoom();
                    if (cueZoom) this.currentZoom = cueZoom;
                }
                const ws = WaveSurfer.create({
                    container: '#waveform',
                    waveColor: document.body.classList.contains('dark') ? '#2a3a50' : '#475569',
                    progressColor: '#E5A100',
                    cursorColor: '#ffffff',
                    cursorWidth: 2,
                    height: 180,
                    minPxPerSec: 1,   // always start minimal — set correct zoom in 'ready'
                    normalize: true,
                    interact: true,
                    hideScrollbar: false,
                    dragToSeek: true,
                    autoCenter: false,
                    autoScroll: false,
                    splitChannels: this.waveformMode === 'stereo'
                });
                if (token !== this._waveInitToken) { ws.destroy(); return; }
                this.waveform = ws;
                
                this.waveformRegions = ws.registerPlugin(WaveSurfer.Regions.create());
                if (WaveSurfer.Minimap) {
                    this.waveformMinimap = ws.registerPlugin(
                        WaveSurfer.Minimap.create({
                            container: '#waveform-mini',
                            height: 120,
                            waveColor: 'rgba(148, 163, 184, 0.5)',
                            progressColor: 'rgba(229, 161, 0, 0.6)',
                            cursorColor: '#ffffff',
                            cursorWidth: 4,
                            overlayColor: 'rgba(0, 0, 0, 0)',
                            dragToSeek: false,
                            interact: true,
                        })
                    );
                }

                const wfContainer = document.getElementById('waveform');
                if (wfContainer) {
                    wfContainer.oncontextmenu = (e) => e.preventDefault();
                    wfContainer.title = 'Scroll to zoom in/out';
                    if (this._waveWheelHandler) {
                        wfContainer.removeEventListener('wheel', this._waveWheelHandler);
                    }
                    this._waveWheelHandler = (e) => this.handleWaveWheel(e);
                    wfContainer.addEventListener('wheel', this._waveWheelHandler, { passive: false });
                }
                const miniEl = document.getElementById('waveform-mini');
                if (miniEl) {
                    miniEl.title = 'Click to move playhead';
                    miniEl.querySelectorAll('[title]').forEach((el) => {
                        if (el !== miniEl) el.removeAttribute('title');
                    });
                    if (this._miniClickHandler) {
                        miniEl.removeEventListener('click', this._miniClickHandler);
                    }
                    this._miniClickHandler = (e) => {
                        if (!this.waveform) return;
                        const rect = miniEl.getBoundingClientRect();
                        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                        this.waveform.seekTo(ratio);
                        this.centerWaveOn(this.waveform.getDuration() * ratio, true);
                    };
                    miniEl.addEventListener('click', this._miniClickHandler);
                }

                const p = await (await fetch(`/api/waveform-peaks/${this.currentFileId}`)).json();
                if (token !== this._waveInitToken) { ws.destroy(); return; }
                ws.load(`/api/audio/${this.currentFileId}`, p.peaks);
                
                ws.once('ready', async () => {
                    await this.$nextTick();
                    const dur = ws.getDuration();
                    const cw = wfContainer?.clientWidth || 800;
                    this.currentZoom = Math.max(1, Math.floor(cw / dur));
                    this.userZoomed = false;
                    ws.zoom(this.currentZoom);
                    this.waveform.seekTo(0);
                    this.addTrackRegions();
                    this.waveformLoading = false;
                    this.drawMinimapMarkers();
                    // Inject scrollbar style into WaveSurfer shadow DOM
                    const wrapperEl = ws.getWrapper?.();
                    const shadowRoot = wrapperEl?.getRootNode?.();
                    if (shadowRoot instanceof ShadowRoot) {
                        const sb = document.createElement('style');
                        sb.textContent = `
                            :host { overflow-x: scroll !important; }
                            ::-webkit-scrollbar { height: 8px; display: block; }
                            ::-webkit-scrollbar-track { background: rgba(0,0,0,0.3); border-radius: 4px; }
                            ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.35); border-radius: 4px; }
                            ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.6); }
                        `;
                        shadowRoot.appendChild(sb);
                    }
                    // Style minimap overlay + cursor for visibility
                    const miniWrap = document.querySelector('#waveform-mini [part=\"minimap\"]');
                    if (miniWrap) {
                        const overlay = miniWrap.querySelector('[part=\"minimap-overlay\"]');
                        if (overlay) {
                            overlay.style.opacity = '0';
                            overlay.style.pointerEvents = 'none';
                        }
                        const wsHost = [...miniWrap.children].find(el => el !== overlay);
                        if (wsHost) {
                            wsHost.style.position = 'relative';
                            wsHost.style.zIndex = '1';
                        }
                    }
                });
                ws.on('play', () => {
                    this.playing = true;
                    this._startVU(ws);
                });
                ws.on('pause', () => {
                    this.playing = false;
                    this._stopVU();
                });
                ws.on('finish', () => {
                    this.playing = false;
                    this._stopVU();
                });

                const _centerOn = (t) => this.centerWaveOn(t, true); // seek/click = always force to center

                const _updateTrackName = (currentTime) => {
                    this.waveCurrentTime = currentTime;
                    const sorted = [...this.detectedTracks].sort((a, b) => a.start - b.start);
                    const active = [...sorted].reverse().find(t => t.start <= currentTime && !t.ignored);
                    const newName = active ? (active.vinyl_number || `#${active.number}`) : '';
                    if (newName !== this.waveCurrentTrackName) {
                        this.waveCurrentTrackName = newName;
                        // Find the index in original detectedTracks for consistent coloring
                        const idx = active ? this.detectedTracks.indexOf(active) : -1;
                        const solidColors = ['#f5a623','#50aaff','#2ecc71','#9b59b6','#e74c3c','#f1c40f','#1abc9c','#ff7eb3'];
                        this.waveCurrentTrackColor = idx >= 0 ? solidColors[idx % solidColors.length] : '';
                        this.drawMinimapMarkers();
                    }
                };

                ws.on('seeking', (currentTime) => {
                    _updateTrackName(currentTime);
                    const hit = [...this.detectedTracks].find(t => !t.ignored && currentTime >= t.start && currentTime <= t.end);
                    if (hit && this.selectedRegionId !== `track-${hit.number}`) {
                        this.selectedRegionId = `track-${hit.number}`;
                        this.addTrackRegions(); // clearRegions() may reset scrollLeft
                        this.$nextTick(() => {
                            _centerOn(currentTime); // re-center after redraw
                            const el = document.querySelector(`[data-cue-id="track-${hit.number}"]`);
                            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        });
                    } else {
                        _centerOn(currentTime);
                    }
                    // Defer to override any scroll reset by WaveSurfer internals (e.g. minimap click)
                    setTimeout(() => _centerOn(currentTime), 0);
                    this.queueMinimapRedraw();
                });

                ws.on('timeupdate', (currentTime) => {
                    _updateTrackName(currentTime);
                    this.centerWaveOn(currentTime); // autoscroll: only when playhead near edge
                    this.queueMinimapRedraw();
                });

                this.waveformRegions.on('region-clicked', (region, e) => {
                    this.selectedRegionId = region.id;
                    this.addTrackRegions();
                    // Scroll the matching cue row into view
                    this.$nextTick(() => {
                        const el = document.querySelector(`[data-cue-id="${region.id}"]`);
                        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    });
                });

                let _regionDragSaved = false;
                this.waveformRegions.on('region-update', () => {
                    if (!_regionDragSaved) { this.saveUndo(); _regionDragSaved = true; }
                });
                this.waveformRegions.on('region-updated', (region) => {
                    _regionDragSaved = false; // reset for next drag
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
            this.saveUndo();
            if (this.detectedTracks.length >= this.maxCues) {
                alert(`Max ${this.maxCues} hotcues reached.`);
                return;
            }
            const num = this.detectedTracks.length + 1;
            const duration = this.waveform.getDuration();
            // Snap end to the start of the next existing cue, or file end
            const sorted = [...this.detectedTracks].sort((a, b) => a.start - b.start);
            const nextCue = sorted.find(t => t.start > startTime + 0.5);
            const endTime = nextCue ? nextCue.start : duration;
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
            this.saveUndo();
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
            this.saveUndo();
            const idx = this.detectedTracks.findIndex(t => t.number === slotNumber);
            if (idx === -1) return;
            this.detectedTracks.splice(idx, 1);
            this.detectedTracks.sort((a,b) => a.start - b.start).forEach((t, i) => t.number = i + 1);
            this.selectedRegionId = null;
            this.addTrackRegions();
        },

        toggleCueBank() {
            this.cueBank = (this.cueBank + 1) % 4;
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

        centerWaveOn(t, force = false) {
            if (!this.waveform) return;
            const dur = this.waveform.getDuration();
            if (!dur) return;
            const wrapper = this.waveform.getWrapper?.();
            if (!wrapper) return;
            const scroller = wrapper.parentElement || wrapper;
            const totalPx = scroller.scrollWidth;
            const cw = scroller.clientWidth || 800;
            if (totalPx <= cw + 2) return; // nothing to scroll
            const playheadPx = (t / dur) * totalPx;
            const scrollLeft = scroller.scrollLeft;
            const margin = cw * 0.15; // scroll when within 15% of edge
            if (force || playheadPx < scrollLeft + margin || playheadPx > scrollLeft + cw - margin) {
                scroller.scrollLeft = Math.max(0, playheadPx - cw / 2);
                this.queueMinimapRedraw();
            }
        },
        getActiveTrackAt(time) {
            const sorted = [...this.detectedTracks].filter(t => !t.ignored).sort((a, b) => a.start - b.start);
            return [...sorted].reverse().find(t => time >= t.start && time <= t.end);
        },
        cycleTimeDisplay() {
            this.timeDisplayMode = (this.timeDisplayMode + 1) % 4;
        },
        getTimeDisplayLabel() {
            switch (this.timeDisplayMode) {
                case 0: return 'TRK';
                case 1: return 'TRK REM';
                case 2: return 'TOTAL';
                case 3: return 'TOTAL REM';
                default: return '';
            }
        },
        getTimeDisplayValue() {
            const total = this.currentFile?.duration || this.waveform?.getDuration() || 0;
            const current = this.waveCurrentTime || 0;
            const track = this.getActiveTrackAt(current);
            const trackElapsed = track ? Math.max(0, current - track.start) : current;
            const trackRemaining = track ? Math.max(0, track.end - current) : Math.max(0, total - current);
            switch (this.timeDisplayMode) {
                case 0:
                    return this.formatDuration(trackElapsed);
                case 1:
                    return `-${this.formatDuration(trackRemaining)}`;
                case 2:
                    return this.formatDuration(total);
                case 3:
                    return `-${this.formatDuration(Math.max(0, total - current))}`;
                default:
                    return this.formatDuration(current);
            }
        },
        getTimeDisplayTooltip() {
            return 'Click to toggle: Track elapsed -> Track remaining -> Total elapsed -> Total remaining';
        },

        zoomIn() {
            if (!this.waveform) return;
            const t = this.waveform.getCurrentTime();
            this.userZoomed = true;
            this.currentZoom = Math.min(this.currentZoom * 1.25, 500);
            this.waveform.zoom(this.currentZoom);
            this.centerWaveOn(t);
            this.queueMinimapRedraw();
        },

        zoomOut() {
            if (!this.waveform) return;
            const t = this.waveform.getCurrentTime();
            this.userZoomed = true;
            const minZoom = this.getMinZoom();
            this.currentZoom = Math.max(minZoom, this.currentZoom / 1.25);
            this.waveform.zoom(this.currentZoom);
            this.centerWaveOn(t);
            this.queueMinimapRedraw();
        },

        resetZoom() {
            if (!this.waveform) return;
            const t = this.waveform.getCurrentTime();
            this.userZoomed = false;
            this.currentZoom = this.computeCueZoom() || 1;
            this.waveform.zoom(this.currentZoom);
            this.centerWaveOn(t);
            this.queueMinimapRedraw();
        },
        getMinZoom() {
            const wfEl = document.getElementById('waveform');
            const width = wfEl?.clientWidth || 0;
            const duration = this.currentFile?.duration || this.waveform?.getDuration() || 0;
            if (!width || !duration) return 1;
            return Math.max(0.1, width / duration);
        },
        handleWaveWheel(e) {
            if (!this.waveform) return;
            e.preventDefault();
            const t = this.waveform.getCurrentTime();
            const minZoom = this.getMinZoom();
            const maxZoom = 500;
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            this.userZoomed = true;
            this.currentZoom = Math.min(maxZoom, Math.max(minZoom, this.currentZoom * factor));
            this.waveform.zoom(this.currentZoom);
            this.centerWaveOn(t, true);
            this.queueMinimapRedraw();
        },

        computeCueZoom() {
            const wfEl = document.getElementById('waveform');
            const width = wfEl?.clientWidth || 0;
            const duration = this.currentFile?.duration || this.waveform?.getDuration() || 0;
            if (!width || !duration) return 50;
            const trackCount = this.detectedTracks.length || 0;
            const visibleCues = Math.min(4, Math.max(2, trackCount || 4));
            const avgCue = trackCount ? (duration / trackCount) : (duration / visibleCues);
            const targetDuration = Math.max(10, avgCue * visibleCues);
            const pxPerSec = width / targetDuration;
            return Math.min(200, Math.max(5, Math.round(pxPerSec)));
        },

        toggleWaveformMode() {
            this.waveformMode = this.waveformMode === 'mono' ? 'stereo' : 'mono';
            this.destroyWaveform();
            this.initWaveform();
        },

        removeSelectedTrack() {
            this.saveUndo();
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

        _startVU(ws) {
            this._stopVU();
            // Simulate VU via periodic random-ish animation driven by waveform volume
            // (Web Audio createMediaElementSource breaks WaveSurfer — avoid it)
            let smooth = 0;
            const tick = () => {
                this._vuRaf = requestAnimationFrame(tick);
                const vol = ws.getVolume ? ws.getVolume() : 1;
                // Rough simulation: random peak weighted by volume
                const raw = (0.4 + Math.random() * 0.6) * vol;
                smooth = smooth * 0.6 + raw * 0.4;
                this.vuLevel = Math.round(smooth * 100);
            };
            tick();
        },
        _stopVU() {
            if (this._vuRaf) { cancelAnimationFrame(this._vuRaf); this._vuRaf = null; }
            this.vuLevel = 0;
        },
        setWaveVolume(v) {
            this.waveVolume = Math.max(0, Math.min(1, v));
            if (this.waveform) this.waveform.setVolume(this.waveVolume);
        },

        drawMinimapMarkers() {
            const miniEl = document.getElementById('waveform-mini');
            if (!miniEl || !this.waveform) return;
            const duration = this.waveform.getDuration();
            if (!duration) return;
            const miniWrap = miniEl.querySelector('[part="minimap"]') || miniEl;
            // Remove old marker canvas if present
            const old = miniWrap.querySelector('.minimap-markers');
            if (old) old.remove();
            const canvas = document.createElement('canvas');
            canvas.className = 'minimap-markers';
            canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;';
            miniWrap.style.position = 'relative';
            miniWrap.appendChild(canvas);
            const w = miniWrap.clientWidth;
            const h = miniWrap.clientHeight;
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            const solidColors = [
                'rgba(245,166,35,0.55)', 'rgba(80,170,255,0.55)', 'rgba(46,204,113,0.55)',
                'rgba(155,89,182,0.55)', 'rgba(231,76,60,0.55)', 'rgba(241,196,15,0.55)',
                'rgba(26,188,156,0.55)', 'rgba(255,126,179,0.55)',
            ];
            const sorted = [...this.detectedTracks].sort((a, b) => a.start - b.start);
            const activeTrack = [...sorted].reverse().find(t => t.start <= this.waveCurrentTime && !t.ignored);
            this.detectedTracks.forEach((t, i) => {
                if (t.ignored) return;
                const x1 = (t.start / duration) * w;
                const x2 = (t.end / duration) * w;
                const isActive = activeTrack && t.number === activeTrack.number;
                ctx.fillStyle = isActive
                    ? solidColors[i % solidColors.length].replace(/[\d.]+\)$/, '0.8)')
                    : solidColors[i % solidColors.length];
                ctx.fillRect(x1, 0, Math.max(1, x2 - x1), h);
                // left border line
                ctx.fillStyle = solidColors[i % solidColors.length].replace(/[\d.]+\)$/, '1)');
                ctx.fillRect(x1, 0, 2, h);
                // white outline for active track
                if (isActive) {
                    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(x1 + 1, 1, Math.max(1, x2 - x1) - 2, h - 2);
                }
                const label = this.getRegionLabel(t);
                if (label && x2 - x1 > 90) {
                    const display = label.length > 20 ? `${label.slice(0, 17)}...` : label;
                    ctx.font = 'bold 12px "Barlow Condensed", sans-serif';
                    ctx.textBaseline = 'top';
                    const textWidth = ctx.measureText(display).width;
                    const padX = 4;
                    const boxW = Math.min(textWidth + padX * 2, (x2 - x1) - 8);
                    ctx.fillStyle = 'rgba(0,0,0,0.7)';
                    ctx.fillRect(x1 + 4, 4, boxW, 18);
                    ctx.fillStyle = '#fff';
                    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                    ctx.lineWidth = 2;
                    ctx.strokeText(display, x1 + 4 + padX, 6);
                    ctx.fillText(display, x1 + 4 + padX, 6);
                }
            });
            const wrapper = this.waveform.getWrapper?.();
            const scroller = wrapper?.parentElement || wrapper;
            if (scroller && scroller.scrollWidth) {
                const totalPx = scroller.scrollWidth;
                const viewPx = scroller.clientWidth || totalPx;
                const scrollPx = scroller.scrollLeft || 0;
                const x1 = (scrollPx / totalPx) * w;
                const x2 = ((scrollPx + viewPx) / totalPx) * w;
                ctx.strokeStyle = '#ff3b30';
                ctx.lineWidth = 2;
                ctx.strokeRect(x1 + 1, 1, Math.max(1, x2 - x1 - 2), h - 2);
            }
            const playheadX = (this.waveCurrentTime / duration) * w;
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 3;
            ctx.shadowColor = 'rgba(0,0,0,0.85)';
            ctx.shadowBlur = 2;
            ctx.beginPath();
            ctx.moveTo(playheadX, 0);
            ctx.lineTo(playheadX, h);
            ctx.stroke();
            ctx.shadowBlur = 0;
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
        getRegionLabel(track) {
            if (!track) return '';
            let label = '';
            let mappedVinyl = '';
            let mappedTitle = '';
            if (this.selectedRelease && Array.isArray(this.selectedRelease.tracks)) {
                const idx = this.detectedTracks.findIndex(t => t.number === track.number);
                const mapIdx = idx >= 0 ? this.customMapping[idx] : null;
                const dt = mapIdx !== null ? this.selectedRelease.tracks[mapIdx] : null;
                if (dt) {
                    mappedVinyl = (dt.position || '').trim();
                    mappedTitle = (dt.title || '').trim();
                }
            }
            const vinyl = mappedVinyl || (track.vinyl_number || '').trim();
            const vinylIsGeneric = /^track\s*\d+$/i.test(vinyl);
            let title = (mappedTitle || track.title || '').trim();
            if (title) {
                title = title.replace(/^track\s*\d+\s*[-–—:]?\s*/i, '').trim();
            }
            if (vinyl && title) {
                if (vinylIsGeneric || title.startsWith(vinyl)) {
                    label = title;
                } else {
                    label = `${vinyl} - ${title}`;
                }
            } else if (title) {
                label = title;
            } else if (vinyl) {
                label = vinyl;
            } else {
                label = `Track ${track.number}`;
            }
            label = label.replace(/^track\s*\d+\s*[-–—:]?\s*/i, '').trim();
            if (label.length > 36) label = `${label.slice(0, 33)}...`;
            return label;
        },
        queueMinimapRedraw() {
            const now = Date.now();
            if (this._minimapRedrawAt && now - this._minimapRedrawAt < 80) return;
            this._minimapRedrawAt = now;
            this.drawMinimapMarkers();
        },
        sanitizeFolderName(name) {
            if (!name) return '';
            let safe = String(name).replace(/\*/g, '');
            safe = safe.replace(/[\/\\:?"<>|]/g, '-');
            safe = safe.replace(/\s+/g, ' ');
            safe = safe.replace(/-+/g, '-');
            safe = safe.trim();
            safe = safe.replace(/^[.\-_ ]+|[.\-_ ]+$/g, '');
            return safe;
        },
        getFormatTag(fmtId) {
            switch (fmtId) {
                case 'flac24': return 'FLAC 24 VINYL';
                case 'mp3_320': return 'MP3 320 VINYL';
                case 'mp3_v0': return 'MP3 V0 VINYL';
                case 'aiff': return 'AIFF VINYL';
                default: return 'FLAC 16 VINYL';
            }
        },
        buildAlbumFolderName(fmtId) {
            const release = this.selectedRelease || {};
            let artist = release.artist || '';
            let title = release.title || '';
            if (!title && this.currentFile?.filename) {
                title = this.cleanFilename(this.currentFile.filename);
            }
            if (!artist) artist = 'Unknown Artist';
            if (!title) title = 'Untitled';
            let label = release.label || 'Unknown Label';
            if (release.catno) label = `${label} - ${release.catno}`;
            const year = release.year || 'Unknown Year';
            const artistSafe = this.sanitizeFolderName(artist);
            const titleSafe = this.sanitizeFolderName(title);
            const labelSafe = this.sanitizeFolderName(label);
            const yearSafe = this.sanitizeFolderName(year);
            const fmtTag = this.getFormatTag(fmtId);
            return `${artistSafe} - ${titleSafe} [${labelSafe}][${yearSafe}][${fmtTag}]`;
        },
        getSuccessRelativePath(fmtId) {
            return this.buildAlbumFolderName(fmtId);
        },
        get successFormatGroups() {
            const files = this.processingStats?.files || [];
            if (!files.length) return [];
            const groups = {};
            files.forEach((f) => {
                const match = String(f).match(/^\[([^\]]+)\]\s*(.+)$/);
                if (!match) return;
                const code = match[1].trim().toUpperCase();
                const name = match[2].trim();
                if (!groups[code]) groups[code] = [];
                groups[code].push(name);
            });
            const labelByCode = {};
            const idByCode = {};
            (this.availableFormats || []).forEach((fmt) => {
                const code = fmt.id.toUpperCase();
                labelByCode[code] = fmt.label;
                idByCode[code] = fmt.id;
            });
            const orderCodes = (this.outputFormats && this.outputFormats.length)
                ? this.outputFormats.map((id) => id.toUpperCase())
                : Object.keys(groups);
            return orderCodes
                .filter((code) => groups[code] && groups[code].length)
                .map((code) => ({
                    code,
                    id: idByCode[code] || code.toLowerCase(),
                    label: labelByCode[code] || code.replace(/_/g, ' '),
                    files: groups[code],
                }));
        },

        addTrackRegions() {
            if(!this.waveformRegions) return;
            this.waveformRegions.clearRegions();
            this.drawMinimapMarkers();
            this.detectedTracks.forEach((t, i) => {
                const isSelected = this.selectedRegionId === `track-${t.number}`;
                const baseColor = t.ignored ? 'rgba(100, 100, 100, 0.3)' : this.getTrackColor(i);
                // Selected: keep track color but more opaque + amber outline via element style
                const color = isSelected ? baseColor.replace(/[\d.]+\)$/, '0.7)') : baseColor;
                const reg = this.waveformRegions.addRegion({
                    start: t.start,
                    end: t.end,
                    color,
                    drag: false,
                    resize: true,
                    id: `track-${t.number}`
                });
                if (reg.element) {
                    const regionLabel = this.getRegionLabel(t);
                    reg.element.removeAttribute('data-region-label');
                    let labelEl = reg.element.querySelector('.region-title');
                    if (!labelEl) {
                        labelEl = document.createElement('div');
                        labelEl.className = 'region-title';
                        reg.element.appendChild(labelEl);
                    }
                    labelEl.textContent = regionLabel;
                    labelEl.style.cssText = [
                        'position:absolute',
                        'top:6px',
                        'left:6px',
                        'background:rgba(0,0,0,0.65)',
                        'color:#fff',
                        'font-size:12px',
                        'font-weight:800',
                        'font-family:"Barlow Condensed", sans-serif',
                        'letter-spacing:.04em',
                        'padding:2px 6px',
                        'border-radius:4px',
                        'white-space:nowrap',
                        'max-width:calc(100% - 12px)',
                        'overflow:hidden',
                        'text-overflow:ellipsis',
                        'pointer-events:none',
                        'text-shadow:0 1px 2px rgba(0,0,0,0.8)',
                        'z-index:12',
                    ].join(';');
                    reg.element.title = 'Click to select track / Move playhead. Scroll to zoom in/out.';
                    reg.element.querySelectorAll('[part~="region-handle"]').forEach((handle) => {
                        const part = (handle.getAttribute('part') || '').toLowerCase();
                        const dataHandle = (handle.getAttribute('data-handle') || handle.getAttribute('data-region-handle') || '').toLowerCase();
                        const handleType = `${part} ${dataHandle} ${handle.className || ''}`.toLowerCase();
                        if (handleType.includes('start')) {
                            handle.title = 'Drag to set start';
                        } else if (handleType.includes('end')) {
                            handle.title = 'Drag to set end';
                        } else {
                            handle.title = 'Drag to adjust boundary';
                        }
                    });
                    if (isSelected) {
                        reg.element.style.boxShadow = 'inset 0 0 0 3px rgba(229, 161, 0, 1)';
                        reg.element.style.zIndex = '3';
                    }
                }
            });
        },

        jumpToTrack(t) {
            if (!t) return;
            this.selectedRegionId = `track-${t.number}`;
            this.addTrackRegions();
            if (this.waveform) {
                const container = document.getElementById('waveform');
                const trackDur = (t.end - t.start) || 1;
                if (container && trackDur) {
                    const targetZoom = Math.min(200, Math.max(1, Math.floor((container.clientWidth * 0.8) / trackDur)));
                    this.currentZoom = targetZoom;
                    this.waveform.zoom(this.currentZoom);
                }
                this.waveform.setTime(t.start);
                this.waveform.play();
                this.centerWaveOn(t.start);
            }
        },

        getSortedCues() {
            return [...this.detectedTracks].sort((a, b) => a.start - b.start);
        },

        prevCue() {
            const cues = this.getSortedCues();
            if (!cues.length) return;
            const time = this.waveform ? this.waveform.getCurrentTime() : 0;
            let idx = cues.findIndex(c => `track-${c.number}` === this.selectedRegionId);
            if (idx < 0) {
                idx = cues.findIndex(c => c.start >= time);
                idx = idx <= 0 ? cues.length - 1 : idx - 1;
            } else {
                idx = idx === 0 ? cues.length - 1 : idx - 1;
            }
            this.jumpToTrack(cues[idx]);
        },

        nextCue() {
            const cues = this.getSortedCues();
            if (!cues.length) return;
            const time = this.waveform ? this.waveform.getCurrentTime() : 0;
            let idx = cues.findIndex(c => `track-${c.number}` === this.selectedRegionId);
            if (idx < 0) {
                idx = cues.findIndex(c => c.start > time);
                idx = idx === -1 ? 0 : idx;
            } else {
                idx = idx === cues.length - 1 ? 0 : idx + 1;
            }
            this.jumpToTrack(cues[idx]);
        },

        skipBy(seconds) {
            if (!this.waveform) return;
            const t = this.waveform.getCurrentTime() + seconds;
            this.waveform.setTime(Math.max(0, Math.min(t, this.waveform.getDuration())));
        },

        // ── Cue row helpers ─────────────────────────────────────────────────
        cueRowAction(slotNumber) {
            const cue = this.detectedTracks.find(t => t.number === slotNumber);
            if (cue) {
                this.jumpToTrack(cue);
            } else {
                this.setCueAtPlayhead(slotNumber);
            }
        },

        getCueDisplayTitle(cue) {
            if (!cue) return '';
            if (cue.title) return cue.title;
            return '';
        },

        handleCueKey(e, cue, field) {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Enter' && e.key !== 'Escape') return;
            if (e.key === 'Enter') { e.target.blur(); return; }
            if (e.key === 'Escape') { e.target.blur(); return; }
            e.preventDefault();
            const step = e.shiftKey ? 1 : 0.1;
            const delta = e.key === 'ArrowUp' ? step : -step;
            const dur = this.waveform ? this.waveform.getDuration() : 9999;
            const minLen = 0.5;
            if (field === 'start') {
                // Shift entire cue, keep duration
                const len = cue.end - cue.start;
                cue.start = Math.max(0, Math.min(cue.start + delta, cue.end - minLen));
                cue.end = Math.min(dur, cue.start + len);
            } else if (field === 'end') {
                cue.end = Math.min(dur, Math.max(cue.end + delta, cue.start + minLen));
            } else if (field === 'duration') {
                cue.end = Math.min(dur, Math.max(cue.start + (cue.end - cue.start) + delta, cue.start + minLen));
            }
            cue.duration = cue.end - cue.start;
            // Update the input value directly so it reflects without blur
            e.target.value = this.formatDuration(
                field === 'start' ? cue.start : field === 'end' ? cue.end : cue.duration
            );
            this.addTrackRegions();
            if (field === 'start' && this.waveform) this.waveform.setTime(cue.start);
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
            const minLen = 0.5;
            if (field === 'start') {
                cue.start = Math.min(secs, cue.end - minLen);
            } else if (field === 'end') {
                cue.end = Math.min(Math.max(secs, cue.start + minLen), dur);
            } else if (field === 'duration') {
                const nextEnd = cue.start + secs;
                cue.end = Math.min(Math.max(nextEnd, cue.start + minLen), dur);
            }
            cue.duration = cue.end - cue.start;
            this.addTrackRegions();
        },

        nudgeSelectedCue(deltaStart, deltaEnd) {
            if (!this.selectedRegionId) return;
            const trackNum = parseInt(this.selectedRegionId.replace('track-', ''));
            const cue = this.detectedTracks.find(t => t.number === trackNum);
            if (!cue) return;
            const dur = this.waveform ? this.waveform.getDuration() : 9999;
            const length = cue.end - cue.start;
            let nextStart = cue.start + deltaStart;
            let nextEnd = cue.end + deltaEnd;
            if (deltaStart === deltaEnd) {
                nextStart = Math.max(0, Math.min(nextStart, dur - length));
                nextEnd = nextStart + length;
            } else {
                nextStart = Math.max(0, Math.min(nextStart, dur));
                nextEnd = Math.max(nextStart + 0.5, Math.min(nextEnd, dur));
            }
            cue.start = nextStart;
            cue.end = nextEnd;
            cue.duration = cue.end - cue.start;
            this.addTrackRegions();
            if (this.waveform) this.waveform.setTime(cue.start);
        },

        nudgeCueLength(delta) {
            if (!this.selectedRegionId) return;
            const trackNum = parseInt(this.selectedRegionId.replace('track-', ''));
            const cue = this.detectedTracks.find(t => t.number === trackNum);
            if (!cue) return;
            const dur = this.waveform ? this.waveform.getDuration() : 9999;
            const nextEnd = Math.min(Math.max(cue.end + delta, cue.start + 0.5), dur);
            cue.end = nextEnd;
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
        async openOutputFolder() {
            const folder = this.processingStats?.output_folder;
            if (!folder) return;
            try { await fetch('/api/utils/open-folder', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ folder }) }); } catch (e) {}
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
                this.appVersion = d.app_version || '';
                document.title = this.appVersion ? `VINYLflowplus v${this.appVersion}` : 'VINYLflowplus';
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
        trackStatus(track) {
            return this.processingTrackState[track.number]?.status || 'queued';
        },
        trackPercent(track) {
            return this.processingTrackState[track.number]?.percent || 0;
        },
        trackFullLabel(track) {
            if (!track) return '';
            const pos = track.vinyl_number || ('#' + track.number);
            const artist = track.artist || '';
            const title = track.title || '';
            if (artist && title) return `${pos} — ${artist} — ${title}`;
            if (title) return `${pos} — ${title}`;
            return pos;
        },
        activeTrackProgressLabel() {
            const track = this.activeProcessingTrack;
            if (!track) return '--';
            const status = this.trackStatus(track);
            if (status === 'active') return 'In progress';
            if (status === 'done') return `${this.trackPercent(track)}%`;
            if (status === 'cancelled') return 'Cancelled';
            if (['error', 'failed'].includes(status)) return 'Failed';
            return `${this.trackPercent(track)}%`;
        },
        formatStage(stage) {
            if (!stage) return '--';
            const s = String(stage).toLowerCase();
            const map = {
                track_start: 'Starting track',
                track_done: 'Track complete',
                analyzing: 'Analyzing',
                processing: 'Processing',
                cancelling: 'Cancelling',
                cancelled: 'Cancelled',
                merging: 'Merging',
                uploading: 'Uploading',
            };
            if (map[s]) return map[s];
            const label = s.replace(/_/g, ' ');
            return label.charAt(0).toUpperCase() + label.slice(1);
        },
        get processingStatusLine() {
            const parts = [];
            const stageLabel = this.formatStage(this.processingStage);
            if (stageLabel && stageLabel !== '--') parts.push(stageLabel);
            const idx = this.processingJob.track_index;
            const total = this.processingJob.track_total;
            if (idx && total) parts.push(`Track ${idx}/${total}`);
            if (this.processingCurrentFormatLabel) parts.push(this.processingCurrentFormatLabel);
            if (this.processingMessage && this.processingMessage !== 'Processing...' && this.processingMessage !== stageLabel) {
                parts.push(this.processingMessage);
            }
            return parts.join(' | ');
        },
        get canCancelProcessing() {
            return this.isProcessing && this.processingJobStatus === 'processing' && this.processingJob.id && !this.processingCancelRequested;
        },
        get showCancelButton() {
            return this.isProcessing && this.processingJob.id && ['processing', 'cancelling'].includes(this.processingJobStatus);
        },
        get processedTrackCount() {
            return this.processingTracks.filter(t => ['done', 'error', 'failed', 'cancelled'].includes(this.trackStatus(t))).length;
        },
        get startedTrackCount() {
            // Count unique tracks that have had at least one format started or completed
            return this.processingTracks.filter(t => {
                const state = this.processingTrackState[t.number];
                if (!state) return false;
                if (['active', 'done', 'error', 'failed', 'cancelled'].includes(state.status)) return true;
                return state.formats && Object.values(state.formats).some(v => v === 'done' || v === 'active');
            }).length;
        },
        get activeProcessingTracks() {
            return this.processingTracks.filter(t => this.trackStatus(t) === 'active');
        },
        get queuedProcessingTracks() {
            return this.processingTracks.filter(t => this.trackStatus(t) === 'queued');
        },
        get doneProcessingTracks() {
            return this.processingTracks.filter(t => this.trackStatus(t) === 'done');
        },
        get failedProcessingTracks() {
            return this.processingTracks.filter(t => ['error', 'failed'].includes(this.trackStatus(t)));
        },
        get cancelledProcessingTracks() {
            return this.processingTracks.filter(t => this.trackStatus(t) === 'cancelled');
        },
        get activeProcessingTrack() {
            if (this.processingCurrentTrackNumber != null) {
                const t = this.processingTracks.find(t => t.number === this.processingCurrentTrackNumber);
                if (t) return t;
            }
            return this.activeProcessingTracks[0] || null;
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

        get cueOverviewMarkers() {
            const duration = this.currentFile?.duration || this.waveform?.getDuration() || 0;
            if (!duration) return [];
            return this.getSortedCues().map(t => ({
                number: t.number,
                left: Math.max(0, Math.min(100, (t.start / duration) * 100)),
            }));
        },

        get visibleCues() {
            const sorted = [...this.detectedTracks].sort((a, b) => a.number - b.number);
            const start = this.cueBank * 8;
            return sorted.slice(start, start + 8);
        },

        get cueSlotsA() {
            return Array.from({ length: 8 }, (_, idx) => {
                const slotNumber = idx + 1;
                const cueIndex = this.detectedTracks.findIndex(t => t.number === slotNumber);
                const cue = cueIndex >= 0 ? this.detectedTracks[cueIndex] : null;
                return { slotNumber, cue, idx: cueIndex >= 0 ? cueIndex : slotNumber - 1 };
            });
        },
        get cueSlotsB() {
            return Array.from({ length: 8 }, (_, idx) => {
                const slotNumber = idx + 9;
                const cueIndex = this.detectedTracks.findIndex(t => t.number === slotNumber);
                const cue = cueIndex >= 0 ? this.detectedTracks[cueIndex] : null;
                return { slotNumber, cue, idx: cueIndex >= 0 ? cueIndex : slotNumber - 1 };
            });
        },
        get cueSlotsC() {
            return Array.from({ length: 8 }, (_, idx) => {
                const slotNumber = idx + 17;
                const cueIndex = this.detectedTracks.findIndex(t => t.number === slotNumber);
                const cue = cueIndex >= 0 ? this.detectedTracks[cueIndex] : null;
                return { slotNumber, cue, idx: cueIndex >= 0 ? cueIndex : slotNumber - 1 };
            });
        },
        get cueSlotsD() {
            return Array.from({ length: 8 }, (_, idx) => {
                const slotNumber = idx + 25;
                const cueIndex = this.detectedTracks.findIndex(t => t.number === slotNumber);
                const cue = cueIndex >= 0 ? this.detectedTracks[cueIndex] : null;
                return { slotNumber, cue, idx: cueIndex >= 0 ? cueIndex : slotNumber - 1 };
            });
        },
        get cueSlots() { return [...this.cueSlotsA, ...this.cueSlotsB, ...this.cueSlotsC, ...this.cueSlotsD]; },

        get nextFileName() {
            if (!this.uploadedFiles.length) return '';
            const remaining = this.uploadedFiles.filter(f => f.id !== this.currentFileId);
            return remaining.length ? remaining[0].filename : '';
        },

        statusClass(s) {
            if(s==='uploaded') return 'text-blue-400'; if(s==='analyzed') return 'text-purple-400';
            if(s==='processing') return 'text-brand animate-pulse'; if(s==='completed') return 'text-green-400';
            if(s==='cancelled') return 'text-slate-400';
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
                        this.processingStats = { tracks: d.tracks ? d.tracks.length : 0, files: d.tracks || [], elapsed, formats: this.outputFormats.length, output_folder: d.output_folder || '' };
                        this.stopProcessingStage();
                        this.successMessage = 'done';
                    } else if (d.type === 'cancelled') {
                        this.processingJobStatus = 'cancelled';
                        this.processingCancelled = true;
                        this.processingCancelRequested = false;
                        this.markTracksCancelled();
                        this.stopProcessPolling();
                        this.stopMetricsPolling();
                        this.successType = 'cancelled';
                        this.successMessage = 'Cancelled';
                        this.stopProcessingStage();
                        this.fetchQueue();
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
