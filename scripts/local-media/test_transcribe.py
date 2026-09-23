import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from transcribe import cache_key, transcribe, validate_transcript


class TranscriptionContract(unittest.TestCase):
    def test_cache_tracks_content_model_language_and_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "speech.wav"
            source.write_bytes(b"audio one")
            model = root / "model"
            model.mkdir()
            (model / "model.bin").write_bytes(b"weights")
            key = cache_key(source, model, "auto", "1")
            self.assertNotEqual(key, cache_key(source, model, "en", "1"))
            self.assertNotEqual(key, cache_key(source, model, "auto", "2"))
            source.write_bytes(b"audio two")
            self.assertNotEqual(key, cache_key(source, model, "auto", "1"))
            source.write_bytes(b"audio one")
            (model / "model.bin").write_bytes(b"replacement weights")
            self.assertNotEqual(key, cache_key(source, model, "auto", "1"))

    def test_cached_transcript_does_not_load_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "speech.wav"
            source.write_bytes(b"audio")
            (root / "model.bin").write_bytes(b"weights")
            result = {"segments": [{"text": "Hello", "words": [{"text": "Hello", "start": 0.5, "end": 1.0}]}]}
            cache = root / "diffusion-studio/transcripts" / (cache_key(source, root, "en", "test") + ".json")
            cache.parent.mkdir(parents=True)
            cache.write_text(json.dumps(result))
            with patch.dict("os.environ", {"XDG_CACHE_HOME": directory}), patch("importlib.metadata.version", return_value="test"), patch.dict("sys.modules", {"faster_whisper": None}):
                self.assertEqual(transcribe(source, root, "en", 1), result)

    def test_invalid_word_times_are_rejected(self):
        for start, end in [(-1, 2), (2, 1), (0, float("inf")), (True, 2)]:
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                validate_transcript({"segments": [{"text": "Hello", "words": [{"text": "Hello", "start": start, "end": end}]}]})
        self.assertEqual(validate_transcript({"segments": []}), {"segments": []})


if __name__ == "__main__":
    unittest.main()
