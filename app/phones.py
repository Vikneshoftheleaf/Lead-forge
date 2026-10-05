import re


def indian_mobile_digits(value):
    if not isinstance(value, str):
        return None

    digits = re.sub(r"\D", "", value)
    if digits.startswith("0091") and len(digits) == 14:
        digits = digits[4:]
    elif digits.startswith("91") and len(digits) == 12:
        digits = digits[2:]
    elif digits.startswith("0") and len(digits) == 11:
        digits = digits[1:]

    if len(digits) != 10 or digits[0] not in "6789":
        return None
    return digits
