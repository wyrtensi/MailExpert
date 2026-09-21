#!/bin/sh
# Seed 500 maildir INBOXes (user001..user500) with 3 small messages each, so
# SELECT/IDLE has real (if tiny) mailboxes to look at, not empty ones.
set -e
N=${1:-500}
i=1
while [ "$i" -le "$N" ]; do
  u=$(printf "user%03d" "$i")
  d="/srv/mail/$u/Maildir"
  mkdir -p "$d/cur" "$d/new" "$d/tmp"
  j=1
  while [ "$j" -le 3 ]; do
    fname="$(date +%s).M${i}P${j}Q0.bench,S=512"
    cat > "$d/new/$fname" <<EOF
Return-Path: <sender@example.com>
From: Sender Name <sender@example.com>
To: ${u}@example.com
Subject: Test message ${j} for ${u}
Date: Mon, 01 Jan 2024 00:00:0${j} +0000
Message-ID: <msg-${i}-${j}@example.com>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

This is small seeded test message number ${j} for ${u}.
Used only for IMAP IDLE/SELECT memory benchmarking (me-bench).
Padding to keep the file a realistic tiny-message size: 0123456789 0123456789 0123456789.
EOF
    j=$((j + 1))
  done
  i=$((i + 1))
done
chown -R 1000:1000 /srv/mail
echo "seeded $N mailboxes"
