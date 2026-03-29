import unittest

from audio_processor import Track
from metadata_handler import DiscogsRelease, MetadataHandler


class FakeArtist:
    def __init__(self, name, join="", anv=""):
        self.name = name
        self.join = join
        self.anv = anv


class FakeTrackEntry:
    def __init__(self, position, title, duration="", artists=None):
        self.position = position
        self.title = title
        self.duration = duration
        self.artists = artists or []


class FakeRelease:
    def __init__(self, artist_name, tracklist):
        self.id = 1
        self.title = "Test Album"
        self.year = 2024
        self.artists = [FakeArtist(artist_name)]
        self.labels = []
        self.formats = []
        self.images = []
        self.genres = []
        self.styles = []
        self.tracklist = tracklist


class TrackArtistResolutionTests(unittest.TestCase):
    def test_single_artist_release_uses_release_artist(self):
        release = DiscogsRelease(
            FakeRelease(
                "Main Artist",
                [FakeTrackEntry("A1", "Single Artist Song")],
            )
        )
        track = Track(1, 0, 60)
        track.vinyl_number = "A1"
        track.title = "Single Artist Song"
        handler = MetadataHandler("", "")
        filename = handler.create_track_filename(track, release, "flac")
        self.assertIn("A1 - Main Artist - Single Artist Song", filename)

    def test_various_release_uses_track_artist(self):
        release = DiscogsRelease(
            FakeRelease(
                "Various",
                [FakeTrackEntry("A1", "I Like Techno", artists=[FakeArtist("Phuture Assassins")])],
            )
        )
        track = Track(1, 0, 60)
        track.vinyl_number = "A1"
        track.title = "I Like Techno"
        handler = MetadataHandler("", "")
        filename = handler.create_track_filename(track, release, "mp3")
        self.assertIn("A1 - Phuture Assassins - I Like Techno", filename)
        self.assertNotIn("Various", filename)

    def test_discogs_suffix_removed_from_track_artist(self):
        release = DiscogsRelease(
            FakeRelease(
                "Various",
                [FakeTrackEntry("B2", "Listen Up", artists=[FakeArtist("E-Type (2)")])],
            )
        )
        track = Track(1, 0, 60)
        track.vinyl_number = "B2"
        track.title = "Listen Up"
        handler = MetadataHandler("", "")
        filename = handler.create_track_filename(track, release, "flac")
        self.assertIn("B2 - E-Type - Listen Up", filename)


if __name__ == "__main__":
    unittest.main()
