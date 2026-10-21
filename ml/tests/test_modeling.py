import math

import numpy as np
import pandas as pd
import pytest
from sklearn.metrics import brier_score_loss, log_loss as sk_log_loss, roc_auc_score

from ml import common
from ml.build_fit_prior import BUCKETS, fit_prior_table
from ml.train_discovery import random_yield, yield_at_k


def test_ece_equal_width_by_hand():
    # Bin (0.1, 0.2]: p=0.2,0.2 with y=0,1 -> |0.5-0.2| = 0.3, weight 0.5
    # Bin (0.7, 0.8]: p=0.8,0.8 with y=1,1 -> |1-0.8| = 0.2, weight 0.5
    y = [0, 1, 1, 1]
    p = [0.2, 0.2, 0.8, 0.8]
    assert common.ece(y, p) == pytest.approx(0.25)


def test_ece_puts_bin_edges_in_the_lower_bin_and_zero_in_the_first():
    # 0.1 sits on an edge: (0, 0.1] is bin 0, same as p = 0.
    assert common.ece([0, 0], [0.0, 0.1]) == pytest.approx(0.05)


def test_ece_equal_mass_uses_equal_count_bins():
    rng = np.random.default_rng(0)
    p = rng.random(1000)
    y = (rng.random(1000) < p).astype(int)
    assert common.ece(y, p, strategy="mass") < 0.08
    assert common.ece(y, np.clip(p + 0.3, 0, 1), strategy="mass") > 0.2


def test_metrics_match_scikit_learn():
    rng = np.random.default_rng(1)
    p = rng.random(200)
    y = (rng.random(200) < p).astype(int)
    assert common.log_loss(y, p) == pytest.approx(sk_log_loss(y, p))
    assert common.brier(y, p) == pytest.approx(brier_score_loss(y, p))
    assert common.roc_auc(y, p) == pytest.approx(roc_auc_score(y, p))
    assert common.roc_auc([1, 1], [0.2, 0.3]) is None


def test_bootstrap_resamples_whole_groups():
    y = np.array([1, 1, 0, 0, 1, 0] * 10)
    p = np.array([0.9, 0.8, 0.2, 0.3, 0.6, 0.4] * 10)
    groups = np.repeat(np.arange(20), 3)
    ci = common.bootstrap_ci(y, p, groups, n_resamples=200)
    lo, hi = ci["log_loss"]
    assert lo <= common.log_loss(y, p) <= hi
    assert set(ci) == {"log_loss", "brier", "auc", "ece_width", "ece_mass", "accuracy"}


def synthetic(n=400, seed=2):
    rng = np.random.default_rng(seed)
    df = pd.DataFrame(
        {
            "self_consistency": rng.choice([1 / 3, 2 / 3, 1.0], n),
            "regex_agree": rng.integers(0, 2, n),
            "regex_absent": 0,
            "grounded": rng.integers(0, 2, n),
            "competing_numbers": rng.integers(0, 10, n).astype(float),
            "private_page_found": rng.integers(0, 2, n),
        }
    )
    z = -1 + 2 * df["self_consistency"] + 1.2 * df["grounded"] + 0.8 * df["regex_agree"] - 0.1 * df["competing_numbers"]
    y = (rng.random(n) < 1 / (1 + np.exp(-z))).astype(int).to_numpy()
    groups = rng.integers(0, 80, n).astype(str)
    return df, y, groups


def test_export_reproduces_predict_proba_including_imputation():
    df, y, groups = synthetic()
    feats = list(df.columns)
    X = df.to_numpy(float)
    pipe = common.build_pipeline(feats, ["self_consistency", "competing_numbers"], 1.0).fit(X, y)
    model = common.export_logistic(pipe, feats, ["self_consistency", "competing_numbers"])
    Xn = X.copy()
    Xn[::7, 4] = np.nan  # missing competing_numbers -> median
    assert np.max(np.abs(common.score_exported(model, Xn) - pipe.predict_proba(Xn)[:, 1])) < 1e-12
    assert model["feature_order"] == feats
    assert set(model["scaler"]) == {"self_consistency", "competing_numbers"}


def test_select_c_uses_grouped_folds_and_log_loss():
    df, y, groups = synthetic()
    feats = list(df.columns)
    folds = common.group_folds(y, groups)
    for tr, te in folds:
        assert not set(groups[tr]) & set(groups[te])
    C, scores, oof = common.select_C(df.to_numpy(float), y, folds, feats, ["self_consistency", "competing_numbers"])
    assert C == min(scores, key=lambda c: (scores[c], c))
    assert len(oof) == len(y)


def test_leakage_assertion():
    train = pd.DataFrame({"venue_id": ["a"], "domain": ["a.com"], "city": ["NYC"], "split": ["train"]})
    test = pd.DataFrame({"venue_id": ["b"], "domain": ["b.com"], "city": ["LA"], "split": ["test_gold"]})
    common.assert_no_leakage(train, test, {"b"})
    with pytest.raises(common.LeakageError):
        common.assert_no_leakage(train, test, {"a"})
    with pytest.raises(common.LeakageError):
        common.assert_no_leakage(train.assign(city="LA"), test, set())
    with pytest.raises(common.LeakageError):
        common.assert_no_leakage(train, test.assign(domain="a.com"), set())


def test_fit_prior_formula_shrinkage_and_monotonicity():
    rooms = {"hotel": [200, 300, 50], "bar_lounge": [40]}
    t = fit_prior_table(rooms, alpha=5, grid=[10, 50, 100, 300])
    # global over 4 venues: >=10: 1, >=50: 3/4, >=100: 2/4, >=300: 1/4
    assert t["global"]["q"] == pytest.approx([1, 0.75, 0.5, 0.25])
    # hotel at 100: (2 + 5 * 0.5) / (3 + 5)
    assert t["buckets"]["hotel"]["q"][2] == pytest.approx(4.5 / 8)
    # empty bucket falls back to the global rate
    assert t["buckets"]["event_space"]["q"] == pytest.approx(t["global"]["q"])
    for b in BUCKETS:
        q = t["buckets"][b]["q"]
        assert all(a >= c for a, c in zip(q, q[1:]))


def test_fit_prior_thin_bucket_uses_the_global_curve():
    rooms = {"hotel": [200], "bar_lounge": [40]}
    t = fit_prior_table(rooms, alpha=5, grid=[10, 50], min_bucket_n=25)
    assert t["buckets"]["hotel"]["q"] == pytest.approx(t["global"]["q"])
    assert t["buckets"]["hotel"]["n"] == 1


def test_yield_at_k():
    y = [1, 0, 1, 0, 0]
    s = [0.9, 0.8, 0.7, 0.1, 0.2]
    assert yield_at_k(y, s, 2) == 0.5
    assert yield_at_k(y, s, 10) == pytest.approx(0.4)
    assert random_yield(y, 2) == pytest.approx(0.4, abs=0.05)


def test_odds_sentence():
    assert common.odds_sentence("grounded", math.log(3.1), None) == "grounded = 1 multiplies the odds by 3.10."


def test_balanced_recalibrated_export_matches_scikit_learn():
    from ml.train_confidence import SCALE_COLS, calibrated_balanced, sigmoid_params

    df, y, groups = synthetic(n=600, seed=5)
    y = (y & (np.random.default_rng(5).random(len(y)) < 0.2)).astype(int)  # ~10% positives: the imbalance path
    feats = list(df.columns)
    X = df.to_numpy(float)
    cal = calibrated_balanced(feats, 1.0, X, y, groups)
    model = common.export_logistic(cal.calibrated_classifiers_[0].estimator, feats, SCALE_COLS)
    model["calibration"] = sigmoid_params(cal)
    assert np.max(np.abs(common.score_exported(model, X) - cal.predict_proba(X)[:, 1])) < 1e-9
    # Recalibration undoes the balanced weights' inflation of the positive rate.
    assert abs(cal.predict_proba(X)[:, 1].mean() - y.mean()) < 0.05


def test_write_parity_keeps_missing_values_as_null(tmp_path, monkeypatch):
    monkeypatch.setenv("TRAINING_EVAL_DIR", str(tmp_path))
    frame = pd.DataFrame({"a": [1.0, np.nan], "b": [0.0, 1.0]})
    path = common.write_parity("t", {"feature_order": ["a", "b"]}, frame, ["a", "b"], [0.2, 0.7])
    saved = common.read_json(path)
    assert saved["rows"] == [{"x": {"a": 1.0, "b": 0.0}, "p": 0.2}, {"x": {"a": None, "b": 1.0}, "p": 0.7}]
    assert oct(path.stat().st_mode & 0o777) == "0o644"
