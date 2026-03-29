"""
VINYLflowplus - Metadata Handling Module

Handles Discogs API integration, metadata tagging, and cover art embedding.
Manages release searches, track mapping, and file tagging for FLAC, MP3, and AIFF.
"""

import re
import time
from pathlib import Path
from typing import List, Tuple, Optional, Dict
from io import BytesIO

import requests
import discogs_client
from mutagen.flac import FLAC, Picture
from mutagen.mp3 import MP3
from mutagen.id3 import ID3, TIT2, TPE1, TPE2, TALB, TDRC, TRCK, TPUB, COMM, APIC, TXXX
from mutagen.aiff import AIFF
from PIL import Image


class DiscogsTrack:
    """Represents a track from Discogs release."""

    def __init__(self, position: str, title: str, duration: str = "", artist: str = ""):
        """
        Initialize Discogs track.

        Args:
            position: Vinyl position (e.g., "A1", "B2")
            title: Track title
            duration: Track duration (e.g., "5:24")
            artist: Track-level artist (cleaned)
        """
        self.position = position
        self.title = title
        self.artist = artist
        self.duration_str = duration
        self.duration_seconds = self._parse_duration(duration)

    def _parse_duration(self, duration_str: str) -> Optional[float]:
        """Parse duration string to seconds."""
        if not duration_str:
            return None

        try:
            # Handle formats like "5:24" or "1:05:24"
            parts = duration_str.split(":")
            if len(parts) == 2:
                minutes, seconds = parts
                return int(minutes) * 60 + int(seconds)
            elif len(parts) == 3:
                hours, minutes, seconds = parts
                return int(hours) * 3600 + int(minutes) * 60 + int(seconds)
        except:
            pass

        return None

    def __repr__(self):
        duration = f" ({self.duration_str})" if self.duration_str else ""
        return f"{self.position}. {self.title}{duration}"


class DiscogsRelease:
    """Represents a Discogs release."""

    @staticmethod
    def _clean_discogs_name(name: str) -> str:
        """
        Clean Discogs names by removing numeric suffixes (e.g., "(2)")
        and trailing asterisks (e.g., "DJ Y*").
        """
        if not name:
            return name
        
        # Discogs names often have suffixes like "Artist (2)" or "Artist*"
        # Sometimes combined like "Artist (2)*" or "Artist* (2)"
        
        # Remove trailing asterisks and numeric suffixes in any order
        while True:
            old_name = name
            # Remove trailing asterisks (and any space before them)
            name = re.sub(r"\s*\*+$", "", name)
            # Remove numeric suffix in parentheses (and any space before it)
            # Only matches if it's at the very end of the string
            name = re.sub(r"\s*\(\d+\)$", "", name)
            name = name.strip()
            if name == old_name:
                break
        
        return name

    @staticmethod
    def _format_title(title: str) -> str:
        """
        Format titles by replacing " / " with " & " as requested.
        This handles split EPs and double titles more cleanly for filenames and tags.
        """
        if not title:
            return title
        
        # Replace " / " with " & " (ensuring spaces are handled)
        return title.replace(" / ", " & ")

    @staticmethod
    def _is_featuring_join(join_text: str) -> bool:
        if not join_text:
            return False
        return bool(re.search(r"\b(feat|ft|featuring)\b", join_text, re.IGNORECASE))

    def _extract_track_artist(self, track) -> str:
        """Extract track-level artist from Discogs tracklist entry."""
        artists = getattr(track, "artists", None)
        if not artists and hasattr(track, "data") and isinstance(track.data, dict):
            artists = track.data.get("artists")

        if not artists:
            return ""

        parts: List[str] = []
        for artist in artists:
            if isinstance(artist, dict):
                name = artist.get("anv") or artist.get("name")
                join = artist.get("join", "")
            else:
                name = getattr(artist, "anv", None) or getattr(artist, "name", None)
                join = getattr(artist, "join", "") or ""

            name = self._clean_discogs_name(name or "")
            name = name.strip()
            if not name:
                continue

            if parts:
                if not parts[-1].endswith(" ") and not parts[-1].endswith("/"):
                    parts.append(" ")
            parts.append(name)

            if join:
                if self._is_featuring_join(join):
                    break
                parts.append(join)

        return "".join(parts).strip()

    def __init__(self, release):
        """
        Initialize from discogs_client Release object.

        Args:
            release: discogs_client Release object
        """
        self.id = release.id
        self.title = self._format_title(self._clean_discogs_name(release.title))
        self.year = getattr(release, "year", "")

        # Get URI for Discogs link - construct from release ID
        self.uri = f"/release/{release.id}"

        # Get artists
        artists = getattr(release, "artists", [])
        raw_artist = artists[0].name if artists else "Unknown Artist"
        self.artist = self._format_title(self._clean_discogs_name(raw_artist))

        # Handle various artists
        if self.artist.lower() in ["various", "various artists"]:
            self.various_artists = True
        else:
            self.various_artists = False

        # Get label and catalog number
        labels = getattr(release, "labels", [])
        if labels:
            first_label = labels[0]
            self.label = self._format_title(self._clean_discogs_name(first_label.name))
            
            # Exhaustive search for catalog number
            self.catno = ""
            # Check all labels if the first one doesn't have it
            for l in labels:
                # Try attributes
                for attr in ['catno', 'catalog_number', 'catalog_no']:
                    if hasattr(l, attr) and getattr(l, attr):
                        self.catno = getattr(l, attr)
                        break
                if self.catno: break
                
                # Try data dictionary (often where discogs_client stores raw response)
                if hasattr(l, 'data') and isinstance(l.data, dict):
                    for key in ['catno', 'catalog_number', 'catalog_no']:
                        if key in l.data and l.data[key]:
                            self.catno = l.data[key]
                            break
                if self.catno: break
        else:
            self.label = ""
            self.catno = ""

        # Get format
        formats = getattr(release, "formats", [])
        self.format = formats[0]["name"] if formats else ""

        # Get images
        self.images = getattr(release, "images", [])
        self.cover_url = self.images[0]["uri"] if self.images else None

        # Get genres and styles
        genres = getattr(release, "genres", [])
        styles = getattr(release, "styles", [])
        all_genres = genres + styles
        self.genre = ", ".join(all_genres) if all_genres else ""

        # Parse tracklist
        self.tracks = self._parse_tracklist(getattr(release, "tracklist", []), debug=False)

    def _parse_tracklist(self, tracklist, debug=False) -> List[DiscogsTrack]:
        """Parse Discogs tracklist to DiscogsTrack objects."""
        tracks = []

        for track in tracklist:
            position = getattr(track, "position", "")
            title = self._format_title(getattr(track, "title", "Unknown"))
            duration = getattr(track, "duration", "")
            track_artist = self._extract_track_artist(track) or self.artist

            # Use Discogs position if available
            if position:
                tracks.append(DiscogsTrack(position, title, duration, track_artist))
            # Handle empty position - assume sequential
            elif title and title.lower() not in ["tracklist", "notes"]:
                tracks.append(DiscogsTrack(str(len(tracks) + 1), title, duration, track_artist))

        # Sort all tracks by position for proper display
        def sort_key(t):
            p = str(t.position)
            if len(p) >= 2 and p[0].isalpha() and p[1:].isdigit():
                return (p[0].upper(), int(p[1:]))
            return (p.upper(), 0)

        if tracks:
            tracks.sort(key=sort_key)
        
        return tracks

    def display_summary(self) -> str:
        """Get formatted summary for display."""
        track_list = ", ".join([t.position for t in self.tracks])
        return (
            f"{self.artist} - {self.title} ({self.year}) [{self.format}] - {self.label}\n"
            f"Tracks: {track_list}"
        )

    def __repr__(self):
        return f"DiscogsRelease({self.artist} - {self.title}, {len(self.tracks)} tracks)"

    def get_full_album_title(self) -> str:
        """Get album title with label and catalog number appended: Title [Label - CatNo]"""
        label_info = self.label or "Unknown Label"
        if self.catno:
            label_info = f"{label_info} - {self.catno}"
        return f"{self.title} [{label_info}]"


class MetadataHandler:
    """Handles Discogs integration and metadata tagging."""

    def __init__(self, discogs_token: str, user_agent: str):
        """
        Initialize metadata handler.

        Args:
            discogs_token: Discogs API token
            user_agent: User agent string
        """
        self.discogs_token = discogs_token
        self.discogs_user_agent = user_agent
        self.client = discogs_client.Client(user_agent, user_token=discogs_token)
        self.last_request_time = 0
        self.min_request_interval = 1.0  # Rate limiting: max 1 req/sec

    def reinitialize(self, discogs_token: str, user_agent: str):
        """
        Reinitialize Discogs client with new credentials.

        Args:
            discogs_token: New Discogs API token
            user_agent: New user agent string
        """
        self.discogs_token = discogs_token
        self.discogs_user_agent = user_agent
        self.client = discogs_client.Client(user_agent, user_token=discogs_token)
        self.last_request_time = 0
        print(f"MetadataHandler reinitialized with new token")

    def _rate_limit(self):
        """Enforce rate limiting between requests."""
        now = time.time()
        elapsed = now - self.last_request_time
        if elapsed < self.min_request_interval:
            time.sleep(self.min_request_interval - elapsed)
        self.last_request_time = time.time()

    def clean_filename(self, filename: str) -> str:
        """
        Clean filename to use as search query.

        Args:
            filename: Input filename

        Returns:
            Cleaned search query
        """
        # Remove extension
        name = Path(filename).stem

        # Replace common separators with spaces
        name = re.sub(r"[-_]+", " ", name)

        # Remove extra spaces
        name = re.sub(r"\s+", " ", name).strip()

        return name

    def search_releases(self, query: str, max_results=5) -> List[Tuple[int, DiscogsRelease]]:
        """
        Search Discogs for releases.

        Args:
            query: Search query
            max_results: Maximum number of results to return

        Returns:
            List of (index, DiscogsRelease) tuples
        """
        self._rate_limit()

        try:
            results = self.client.search(query, type="release")
            releases = []

            for i, result in enumerate(results, 1):
                if i > max_results:
                    break

                try:
                    self._rate_limit()
                    release = self.client.release(result.id)
                    releases.append((i, DiscogsRelease(release)))
                except Exception as e:
                    print(f"Warning: Failed to fetch release {result.id}: {e}")
                    continue

            return releases

        except Exception as e:
            print(f"Search failed: {e}")
            return []

    def get_release_by_id(self, release_id: int) -> Optional[DiscogsRelease]:
        """
        Get release by Discogs ID.

        Args:
            release_id: Discogs release ID

        Returns:
            DiscogsRelease or None
        """
        try:
            self._rate_limit()
            release = self.client.release(release_id)
            return DiscogsRelease(release)
        except Exception as e:
            print(f"Failed to fetch release {release_id}: {e}")
            return None

    def download_cover_art(self, url: str, output_path: Path, max_size=1400) -> bool:
        """
        Download and save cover art.

        Args:
            url: Image URL
            output_path: Where to save the image
            max_size: Maximum dimension for embedding (resize if larger)

        Returns:
            True if successful
        """
        try:
            headers = {"User-Agent": self.client.user_agent}
            response = requests.get(url, headers=headers, timeout=30)
            response.raise_for_status()

            img = Image.open(BytesIO(response.content))

            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGB")

            img.save(output_path, "JPEG", quality=95)
            return True

        except Exception as e:
            print(f"Failed to download cover art: {e}")
            return False

    def prepare_cover_for_embedding(self, image_path: Path, max_size=1400) -> Optional[bytes]:
        """
        Prepare cover art for embedding in audio files.

        Args:
            image_path: Path to image file
            max_size: Maximum dimension

        Returns:
            Image bytes (JPEG), or None if error
        """
        try:
            img = Image.open(image_path)

            if img.mode != "RGB":
                img = img.convert("RGB")

            if max(img.size) > max_size:
                img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)

            buffer = BytesIO()
            img.save(buffer, "JPEG", quality=90)
            return buffer.getvalue()

        except Exception as e:
            print(f"Failed to prepare cover art: {e}")
            return None

    def tag_file(
        self,
        file_path: Path,
        track: "Track",
        release: DiscogsRelease,
        cover_data: Optional[bytes] = None,
        output_format: str = "flac",
    ) -> bool:
        """
        Write metadata tags to an audio file.
        Dispatches to the correct tagger based on output format.

        Args:
            file_path: Path to audio file
            track: Track object with vinyl_number set
            release: DiscogsRelease object
            cover_data: Optional cover art bytes to embed
            output_format: One of 'flac', 'mp3', 'aiff'

        Returns:
            True if successful
        """
        if output_format == "flac" or output_format == "flac24":
            return self._tag_flac(file_path, track, release, cover_data)
        elif output_format in ["mp3", "mp3_320", "mp3_v0"]:
            return self._tag_mp3(file_path, track, release, cover_data)
        elif output_format == "aiff":
            return self._tag_aiff(file_path, track, release, cover_data)
        else:
            print(f"Unsupported output format for tagging: {output_format}")
            return False

    # Keep the old name as an alias for backwards compatibility (used by CLI)
    def tag_flac_file(self, file_path, track, release, cover_data=None):
        """Backwards-compatible alias for tag_file with FLAC format."""
        return self._tag_flac(file_path, track, release, cover_data)

    def _find_discogs_track(self, track, release):
        """Find the Discogs track matching a vinyl_number."""
        if not track.vinyl_number:
            return None
            
        target = str(track.vinyl_number).strip().upper()
        for dt in release.tracks:
            if str(dt.position).strip().upper() == target:
                return dt
        print(f"Warning: No Discogs track found for {track.vinyl_number}")
        return None

    def _resolve_track_artist(self, track, release, discogs_track=None) -> str:
        """Resolve track-level artist, falling back to release artist."""
        if discogs_track is None:
            discogs_track = self._find_discogs_track(track, release)
        if discogs_track and getattr(discogs_track, "artist", None):
            return discogs_track.artist
        return release.artist or "Unknown Artist"

    def _get_disc_number(self, position: str) -> str:
        """Determine disc number from vinyl position (A/B=1, C/D=2, etc.)"""
        if not position or not position[0].isalpha():
            return "1"
        
        letter = position[0].upper()
        # Map letters to disc numbers: A,B=1; C,D=2; E,F=3; G,H=4
        order = ord(letter) - ord('A')
        disc_num = (order // 2) + 1
        return str(disc_num)

    def _tag_flac(
        self,
        file_path: Path,
        track: "Track",
        release: DiscogsRelease,
        cover_data: Optional[bytes] = None,
    ) -> bool:
        """Write Vorbis comment tags to FLAC file."""
        try:
            print(f"DEBUG: Tagging FLAC {file_path} with position {track.vinyl_number}")
            audio = FLAC(file_path)
            
            discogs_track = self._find_discogs_track(track, release)
            track_artist = self._resolve_track_artist(track, release, discogs_track)
            album_artist = release.artist

            # Always tag what we have, even if find_discogs_track fails
            audio["artist"] = [track_artist]
            audio["albumartist"] = [album_artist]
            audio["album"] = [release.get_full_album_title()]
            audio["tracknumber"] = [str(track.vinyl_number)]
            audio["discnumber"] = [self._get_disc_number(track.vinyl_number)]

            if discogs_track:
                audio["title"] = [discogs_track.title]
            elif track.title:
                audio["title"] = [track.title]
            else:
                audio["title"] = ["Unknown Track"]
            
            # Professional Vinyl Metadata
            if release.year:
                audio["date"] = [str(release.year)]
            if release.label:
                audio["label"] = [release.label]
                audio["publisher"] = [release.label]
            if release.catno:
                audio["catalognumber"] = [release.catno]
            if release.genre:
                audio["genre"] = [release.genre]

            audio["discogs_release_id"] = [str(release.id)]
            audio["comment"] = ["Digitized from vinyl"]

            if cover_data:
                # Clear old pictures and add new one
                audio.clear_pictures()
                picture = Picture()
                picture.type = 3  # Front cover
                picture.mime = "image/jpeg"
                picture.desc = "Cover"
                picture.data = cover_data
                audio.add_picture(picture)

            audio.save()
            print(f"Successfully tagged {file_path}")
            return True

        except Exception as e:
            print(f"Failed to tag {file_path}: {e}")
            return False

    def _tag_mp3(
        self,
        file_path: Path,
        track: "Track",
        release: DiscogsRelease,
        cover_data: Optional[bytes] = None,
    ) -> bool:
        """Write ID3v2 tags to MP3 file."""
        try:
            print(f"DEBUG: Tagging MP3 {file_path} with position {track.vinyl_number}")
            audio = MP3(file_path, ID3=ID3)

            try:
                audio.add_tags()
            except Exception:
                pass  # Tags already exist

            discogs_track = self._find_discogs_track(track, release)
            track_artist = self._resolve_track_artist(track, release, discogs_track)
            album_artist = release.artist

            # Core tags
            audio.tags["TPE1"] = TPE1(encoding=3, text=track_artist)
            audio.tags["TPE2"] = TPE2(encoding=3, text=album_artist)
            audio.tags["TALB"] = TALB(encoding=3, text=release.get_full_album_title())
            audio.tags["TRCK"] = TRCK(encoding=3, text=str(track.vinyl_number))

            title = "Unknown Track"
            if discogs_track:
                title = discogs_track.title
            elif track.title:
                title = track.title
            
            audio.tags["TIT2"] = TIT2(encoding=3, text=title)
            
            # Professional Vinyl Metadata
            # TPOS = Disc Number (part of set)
            from mutagen.id3 import TPOS
            audio.tags["TPOS"] = TPOS(encoding=3, text=self._get_disc_number(track.vinyl_number))

            if release.year:
                audio.tags["TDRC"] = TDRC(encoding=3, text=str(release.year))

            if release.label:
                audio.tags["TPUB"] = TPUB(encoding=3, text=release.label)
            
            if release.catno:
                audio.tags["TXXX:CATALOGNUMBER"] = TXXX(
                    encoding=3, desc="CATALOGNUMBER", text=release.catno
                )

            if release.genre:
                from mutagen.id3 import TCON
                audio.tags["TCON"] = TCON(encoding=3, text=release.genre)

            audio.tags["TXXX:DISCOGS_RELEASE_ID"] = TXXX(
                encoding=3, desc="DISCOGS_RELEASE_ID", text=str(release.id)
            )
            audio.tags["COMM"] = COMM(
                encoding=3, lang="eng", desc="", text="Digitized from vinyl"
            )

            if cover_data:
                audio.tags["APIC"] = APIC(
                    encoding=3, mime="image/jpeg", type=3, desc="Cover", data=cover_data,
                )

            audio.save()
            print(f"Successfully tagged {file_path}")
            return True

        except Exception as e:
            print(f"Failed to tag {file_path}: {e}")
            return False

    def fix_track_tags_from_filename(self, file_path: Path, output_format: str) -> bool:
        """
        Final safety step: Extract track position from filename and force it into the tag.
        This ensures that even if Discogs mapping failed, the track tag is correct.
        Filename format is expected to be: 'Position - Artist - Title.ext'
        """
        try:
            filename = file_path.name
            # Extract first part before the first " - "
            parts = filename.split(" - ")
            if len(parts) < 2:
                return False
                
            track_pos = parts[0].strip()
            print(f"DEBUG: Final safety tag check for {filename} -> position {track_pos}")
            
            if output_format.startswith("flac"):
                audio = FLAC(file_path)
                audio["tracknumber"] = [str(track_pos)]
                audio.save()
            elif output_format in ["mp3", "mp3_320", "mp3_v0"]:
                audio = MP3(file_path, ID3=ID3)
                audio.tags["TRCK"] = TRCK(encoding=3, text=str(track_pos))
                audio.save()
            elif output_format == "aiff":
                audio = AIFF(file_path)
                audio.tags["TRCK"] = TRCK(encoding=3, text=str(track_pos))
                audio.save()
            return True
        except Exception as e:
            print(f"Safety tagging failed for {file_path}: {e}")
            return False

    def _tag_aiff(
        self,
        file_path: Path,
        track: "Track",
        release: DiscogsRelease,
        cover_data: Optional[bytes] = None,
    ) -> bool:
        """Write ID3v2 tags to AIFF file (AIFF uses ID3 tags like MP3)."""
        try:
            print(f"DEBUG: Tagging AIFF {file_path} with position {track.vinyl_number}")
            audio = AIFF(file_path)

            try:
                audio.add_tags()
            except Exception:
                pass  # Tags already exist

            discogs_track = self._find_discogs_track(track, release)
            track_artist = self._resolve_track_artist(track, release, discogs_track)
            album_artist = release.artist

            # Core tags
            audio.tags["TPE1"] = TPE1(encoding=3, text=track_artist)
            audio.tags["TPE2"] = TPE2(encoding=3, text=album_artist)
            audio.tags["TALB"] = TALB(encoding=3, text=release.get_full_album_title())
            audio.tags["TRCK"] = TRCK(encoding=3, text=str(track.vinyl_number))

            title = "Unknown Track"
            if discogs_track:
                title = discogs_track.title
            elif track.title:
                title = track.title
                
            audio.tags["TIT2"] = TIT2(encoding=3, text=title)
            
            # Professional Vinyl Metadata
            # TPOS = Disc Number (part of set)
            from mutagen.id3 import TPOS
            audio.tags["TPOS"] = TPOS(encoding=3, text=self._get_disc_number(track.vinyl_number))

            if release.year:
                audio.tags["TDRC"] = TDRC(encoding=3, text=str(release.year))

            if release.label:
                audio.tags["TPUB"] = TPUB(encoding=3, text=release.label)
            
            if release.catno:
                audio.tags["TXXX:CATALOGNUMBER"] = TXXX(
                    encoding=3, desc="CATALOGNUMBER", text=release.catno
                )

            if release.genre:
                from mutagen.id3 import TCON
                audio.tags["TCON"] = TCON(encoding=3, text=release.genre)

            audio.tags["TXXX:DISCOGS_RELEASE_ID"] = TXXX(
                encoding=3, desc="DISCOGS_RELEASE_ID", text=str(release.id)
            )
            audio.tags["COMM"] = COMM(
                encoding=3, lang="eng", desc="", text="Digitized from vinyl"
            )

            if cover_data:
                audio.tags["APIC"] = APIC(
                    encoding=3, mime="image/jpeg", type=3, desc="Cover", data=cover_data,
                )

            audio.save()
            print(f"Successfully tagged {file_path}")
            return True

        except Exception as e:
            print(f"Failed to tag {file_path}: {e}")
            return False

    def sanitize_filename(self, name: str) -> str:
        """Sanitize string for use in filename."""
        if not name:
            return ""
            
        # First remove common Discogs characters we definitely don't want as hyphens
        name = name.replace("*", "")
        
        # Replace other forbidden characters with hyphens
        name = re.sub(r'[/\\:?"<>|]', "-", name)
        
        # Clean up whitespace and repetitive hyphens
        name = re.sub(r"\s+", " ", name)
        name = re.sub(r"-+", "-", name)
        
        # Strip from both ends
        name = name.strip(" .-_")
        
        return name

    def create_album_folder_name(self, release: DiscogsRelease, output_format: str = "flac") -> str:
        """Create folder name for album with extra metadata."""
        artist = self.sanitize_filename(release.artist)
        title = self.sanitize_filename(release.title)
        
        # Combine label and catalog number
        label_str = self.sanitize_filename(release.label or "Unknown Label")
        if release.catno:
            catno = self.sanitize_filename(release.catno)
            label_str = f"{label_str} - {catno}"
            
        year = release.year or "Unknown Year"
        
        # Determine format tag
        fmt_tag = "FLAC 16 VINYL"
        if output_format == "flac24":
            fmt_tag = "FLAC 24 VINYL"
        elif output_format == "mp3_320":
            fmt_tag = "MP3 320 VINYL"
        elif output_format == "mp3_v0":
            fmt_tag = "MP3 V0 VINYL"
        elif output_format == "aiff":
            fmt_tag = "AIFF VINYL"
            
        return f"{artist} - {title} [{label_str}][{year}][{fmt_tag}]"

    def create_track_filename(
        self, track: "Track", release: DiscogsRelease, output_format: str = "flac"
    ) -> str:
        """
        Create filename for track.

        Args:
            track: Track object with vinyl_number set
            release: DiscogsRelease object
            output_format: One of 'flac', 'mp3', 'aiff'

        Returns:
            Filename (e.g., "A1-Groove La Chord.flac")
        """
        from audio_processor import OUTPUT_FORMATS

        format_config = OUTPUT_FORMATS.get(output_format, OUTPUT_FORMATS["flac"])
        ext = format_config["extension"]

        discogs_track = self._find_discogs_track(track, release)
        track_artist = self._resolve_track_artist(track, release, discogs_track)
        artist = self.sanitize_filename(track_artist)
        
        title = "Unknown"
        if discogs_track:
            title = self.sanitize_filename(discogs_track.title)
        elif track.title:
            title = self.sanitize_filename(track.title)
            
        return f"{track.vinyl_number} - {artist} - {title}{ext}"


def compare_track_durations(
    detected_tracks: List["Track"], discogs_tracks: List[DiscogsTrack], tolerance=5.0
) -> Dict:
    """
    Compare detected tracks with Discogs tracks to validate matching.

    Args:
        detected_tracks: List of detected Track objects
        discogs_tracks: List of DiscogsTrack objects from Discogs
        tolerance: Tolerance in seconds for duration mismatch

    Returns:
        Dict with 'matches', 'warnings', and 'errors' keys
    """
    result = {
        "matches": [],
        "warnings": [],
        "errors": [],
        "total_detected": len(detected_tracks),
        "total_discogs": len(discogs_tracks),
    }

    if len(detected_tracks) != len(discogs_tracks):
        result["errors"].append(
            f"Track count mismatch: detected {len(detected_tracks)}, "
            f"Discogs has {len(discogs_tracks)}"
        )

    for i, det_track in enumerate(detected_tracks):
        if i < len(discogs_tracks):
            discogs_duration = discogs_tracks[i].duration_seconds

            if discogs_duration:
                diff = abs(det_track.duration - discogs_duration)

                if diff < tolerance:
                    result["matches"].append(
                        f"Track {i+1}: Duration match ({det_track.duration:.0f}s)"
                    )
                elif diff > tolerance * 2:
                    if i + 1 < len(discogs_tracks):
                        next_duration = discogs_tracks[i + 1].duration_seconds
                        if next_duration:
                            combined = discogs_duration + next_duration
                            if abs(det_track.duration - combined) < tolerance:
                                result["warnings"].append(
                                    f"Track {i+1} ({det_track.duration:.0f}s) appears to contain "
                                    f"2 tracks: {discogs_tracks[i].position} + {discogs_tracks[i+1].position} "
                                    f"(combined: {combined:.0f}s)"
                                )

    return result
