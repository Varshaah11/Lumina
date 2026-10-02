"""
Text normalization for TTS.

Turns symbols that carry meaning (%, $, &, /, -, =, ...) into speakable words instead of
deleting them, then strips leftover formatting characters. Pure functions, no model needed.
"""
import re

_MAGNITUDES = {"k": "thousand", "m": "million", "b": "billion", "bn": "billion"}

_URL_RE = re.compile(r"https?://([^\s/]+)(?:/\S*)?", re.IGNORECASE)
_ISO_DATE_RE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
_CURRENCY_RE = re.compile(r"\$\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(bn|[kKmMbB])\b)?")
_PERCENT_RE = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*%")
_ACRONYM_AMP_RE = re.compile(r"\b([A-Z]{1,3})&([A-Z]{1,3})\b")
_AND_OR_RE = re.compile(r"\band/or\b", re.IGNORECASE)
_TWENTY_FOUR_SEVEN_RE = re.compile(r"\b24/7\b")
_NUM_SLASH_RE = re.compile(r"(?<![\d/.])(\d{1,4})/(\d{1,4})(?:/(\d{1,4}))?(?![\d/])")
_NUM_RANGE_RE = re.compile(r"(?<![\w.-])(\d+(?:\.\d+)?)\s?[-–]\s?(\d+(?:\.\d+)?)(?![\w.-])")
_NEGATIVE_RE = re.compile(r"(?<![\w.)\]-])-(?=\d)")
_MATH_EQ_RE = re.compile(r"(?<=[\w)])\s*(?<![=<>!])=(?![=])\s*(?=[\w(-])")
_MATH_TIMES_RE = re.compile(r"(?<=\d)\s*[*×]\s*(?=\d)")
_MATH_POWER_RE = re.compile(r"(?<=\d)\s*\^\s*(?=\d)")
_MATH_CMP_RE = re.compile(r"(?<=[\w)])\s+(<=|>=|<|>)\s+(?=[\w(])")
_CMP_WORDS = {"<": "less than", ">": "greater than", "<=": "less than or equal to", ">=": "greater than or equal to"}
_STRIP_RE = re.compile(r"[-=_*#`~<>|•–—▪▫◆◇➢▶(){}\[\]/\\^@&$%]+")


def _spell(letters: str) -> str:
    return " ".join(letters)


def _currency(m: re.Match) -> str:
    amount = m.group(1)
    suffix = (m.group(2) or "").lower()
    if suffix:
        return f" {amount} {_MAGNITUDES[suffix]} dollars "
    return f" {amount} {'dollar' if amount == '1' else 'dollars'} "


def _range(m: re.Match) -> str:
    left, right = m.group(1), m.group(2)
    # 555-1234 style phone fragments are not ranges
    if len(left) == 3 and len(right) == 4:
        return f"{left} {right}"
    return f"{left} to {right}"


def normalize_for_speech(text: str) -> str:
    """Returns speech-friendly text. Result may be empty if nothing speakable remains."""
    if not text:
        return ""
    t = text

    # URLs: keep the host only; paths are not speakable
    t = _URL_RE.sub(lambda m: m.group(1).rstrip(".,;:!?"), t)

    # Dates / numbers
    t = _ISO_DATE_RE.sub(r"\1 \2 \3", t)
    t = _CURRENCY_RE.sub(_currency, t)
    t = _PERCENT_RE.sub(r"\1 percent", t)
    t = _TWENTY_FOUR_SEVEN_RE.sub("twenty four seven", t)
    t = _NUM_SLASH_RE.sub(lambda m: " slash ".join(g for g in m.groups() if g), t)
    t = _NUM_RANGE_RE.sub(_range, t)
    t = _NEGATIVE_RE.sub(" minus ", t)

    # Ampersands and slashes in words
    t = _ACRONYM_AMP_RE.sub(lambda m: f"{_spell(m.group(1))} and {_spell(m.group(2))}", t)
    t = t.replace("&amp;", " and ")
    t = t.replace("&", " and ")
    t = _AND_OR_RE.sub("and or", t)

    # Math
    t = _MATH_TIMES_RE.sub(" times ", t)
    t = _MATH_POWER_RE.sub(" to the power of ", t)
    t = _MATH_CMP_RE.sub(lambda m: f" {_CMP_WORDS[m.group(1)]} ", t)
    t = _MATH_EQ_RE.sub(" equals ", t)

    # Remaining symbols with a spoken form
    t = re.sub(r"%", " percent ", t)
    t = re.sub(r"(?<=\S)@(?=\S)", " at ", t)
    t = re.sub(r"#(?=\d)", " number ", t)
    t = re.sub(r"~(?=\d)", " approximately ", t)

    # Strip leftover formatting/delimiter characters (content between them is kept)
    t = _STRIP_RE.sub(" ", t)
    t = re.sub(r"\s+", " ", t).strip()
    # Replacements pad with spaces; keep sentence punctuation attached so chunk splitting still works
    t = re.sub(r"\s+([.,!?;:])", r"\1", t)
    return t
