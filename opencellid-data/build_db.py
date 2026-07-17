#!/usr/bin/env python3
"""Load the OpenCelliD MCC-250 CSV dump into SQLite for nearest-LTE-tower lookups.

The dump has NO header; column order (OpenCelliD canonical, lon BEFORE lat):
    radio, mcc, net, area, cell, unit, lon, lat, range, samples,
    changeable, created, updated, averageSignal

We keep the full table (all radios, 14 cols) for inspection but drive the sync
off a PARTIAL index restricted to radio='LTE' — a modern phone should never be
handed a GSM/UMTS cell, and 82k LTE rows index trivially.
"""
import csv
import os
import sqlite3
import sys

SRC = os.path.join(os.path.dirname(__file__), '250.csv')
DB = os.path.join(os.path.dirname(__file__), 'towers.db')

COLS = ['radio', 'mcc', 'net', 'area', 'cell', 'unit', 'lon', 'lat',
        'range', 'samples', 'changeable', 'created', 'updated', 'averageSignal']
INT_COLS = {'mcc', 'net', 'area', 'cell', 'unit', 'range', 'samples',
            'changeable', 'created', 'updated', 'averageSignal'}

if os.path.exists(DB):
    os.remove(DB)

con = sqlite3.connect(DB)
cur = con.cursor()
cur.execute("""
    CREATE TABLE towers (
        radio TEXT, mcc INTEGER, net INTEGER, area INTEGER, cell INTEGER,
        unit INTEGER, lon REAL, lat REAL, range INTEGER, samples INTEGER,
        changeable INTEGER, created INTEGER, updated INTEGER, averageSignal INTEGER
    )
""")

placeholders = ','.join('?' * len(COLS))
rows = 0
batch = []
with open(SRC, newline='') as f:
    for rec in csv.reader(f):
        if len(rec) != len(COLS):
            continue
        vals = []
        for name, v in zip(COLS, rec):
            if name == 'radio':
                vals.append(v)
            elif name in ('lon', 'lat'):
                vals.append(float(v) if v != '' else None)
            else:
                vals.append(int(v) if v != '' else None)
        batch.append(vals)
        if len(batch) >= 5000:
            cur.executemany(f"INSERT INTO towers ({','.join(COLS)}) VALUES ({placeholders})", batch)
            rows += len(batch)
            batch = []
if batch:
    cur.executemany(f"INSERT INTO towers ({','.join(COLS)}) VALUES ({placeholders})", batch)
    rows += len(batch)

# Partial spatial index: only LTE rows, (lat, lon) — lat narrows the bbox scan,
# lon is the residual filter. This is what nearestLteTower() rides.
cur.execute("CREATE INDEX idx_towers_lte_latlon ON towers(lat, lon) WHERE radio='LTE'")
con.commit()

cur.execute("SELECT radio, COUNT(*) FROM towers GROUP BY radio ORDER BY 2 DESC")
by_radio = cur.fetchall()
cur.execute("SELECT COUNT(*) FROM towers WHERE radio='LTE'")
lte = cur.fetchone()[0]

con.close()
sz = os.path.getsize(DB)
print(f"loaded {rows} rows -> {DB} ({sz/1024/1024:.1f} MB)")
print("by radio:", ", ".join(f"{r}={c}" for r, c in by_radio))
print(f"LTE (sync set): {lte}")
