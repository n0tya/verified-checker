-- 利用回数の集計。日付（日本時間）と種類ごとの回数だけを持つ。個人を特定する情報は入れない
CREATE TABLE IF NOT EXISTS daily (
  day   TEXT NOT NULL,
  event TEXT NOT NULL,
  n     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event)
);
