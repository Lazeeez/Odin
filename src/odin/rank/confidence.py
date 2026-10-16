from __future__ import annotations

import numpy as np

from odin.rank.browser import FEATURES

MIN_CHARS = 50

CONFIDENCE_FEATURES = [
    "top_score",
    "gap_1_2",
    "gap_1_10",
    "top_share",
    "entropy",
    "log_candidates",
    "stack_trace",
    "named",
    "path_named",
    "log_chars",
]
_COL = {
    n: FEATURES.index(n)
    for n in (
        "frame_name",
        "frame_both",
        "qual_mentioned",
        "name_in_code",
        "path_mentioned",
        "module_mentioned",
    )
}


def confidence_features(scores: np.ndarray, X: np.ndarray, chars: int) -> np.ndarray:
    scores = np.asarray(scores, np.float64)
    if not len(scores):
        return np.array([0.0] * (len(CONFIDENCE_FEATURES) - 1) + [np.log1p(chars)])
    order = np.argsort(-scores, kind="stable")[:10]
    top = scores[order]
    e = np.exp(top - top[0])
    p = e / e.sum()
    rows = np.asarray(X)[order]

    def present(*names: str) -> float:
        return float(any((rows[:, _COL[n]] > 0).any() for n in names))

    return np.array(
        [
            top[0],
            top[0] - (top[1] if len(top) > 1 else top[0]),
            top[0] - top[-1],
            p[0],
            float(-(p * np.log(p)).sum()),
            np.log1p(len(scores)),
            present("frame_name", "frame_both"),
            present("qual_mentioned", "name_in_code"),
            present("path_mentioned", "module_mentioned"),
            np.log1p(chars),
        ]
    )


def fit_logistic(F: np.ndarray, y: np.ndarray, l2: float = 1.0, iterations: int = 100) -> dict:
    F = np.asarray(F, np.float64)
    y = np.asarray(y, np.float64)
    mean = F.mean(axis=0)
    std = F.std(axis=0)
    std[std == 0] = 1.0
    Z = np.hstack([(F - mean) / std, np.ones((len(F), 1))])
    w = np.zeros(Z.shape[1])
    penalty = np.full(Z.shape[1], l2)
    penalty[-1] = 0.0
    for _ in range(iterations):
        p = 1 / (1 + np.exp(-Z @ w))
        gradient = Z.T @ (p - y) + penalty * w
        hessian = (Z * (p * (1 - p))[:, None]).T @ Z + np.diag(penalty)
        step = np.linalg.solve(hessian, gradient)
        w -= step
        if np.abs(step).max() < 1e-10:
            break
    return {
        "features": CONFIDENCE_FEATURES,
        "mean": mean.tolist(),
        "std": std.tolist(),
        "weights": w[:-1].tolist(),
        "bias": float(w[-1]),
    }


def predict_confidence(model: dict, F: np.ndarray) -> np.ndarray:
    F = np.atleast_2d(np.asarray(F, np.float64))
    z = (F - np.asarray(model["mean"])) / np.asarray(model["std"])
    return 1 / (1 + np.exp(-(z @ np.asarray(model["weights"]) + model["bias"])))
