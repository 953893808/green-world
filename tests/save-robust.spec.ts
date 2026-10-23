import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/game/balance';
import { newGame } from '../src/game/game';
import { simulateSeason } from '../src/game/rules/advance';
import { finishSeason } from '../src/game/rules/qualify';
import { encodeSave } from '../src/game/save/encode';
import { decodeSave, loadSave } from '../src/game/save/decode';
import { saveSizeKB } from '../src/game/save/persist';
import type { SaveGame } from '../src/game/types';

const SEED = 20261019;

describe('存档健壮性：赛季结算态与坏列', () => {
  it('赛季结算后存档往返：对阵双方与赛果仍属于同一场', { timeout: 180000 }, () => {
    const session = newGame({ seed: SEED, mode: 'manager', manager: { clubId: 'eng-t1-01' } });
    const finished = finishSeason(simulateSeason(session.world));
    const save = encodeSave(finished, session.state);
    const back = decodeSave(save).world;

    const byId = new Map(finished.fixtures.map((f) => [f.id, f]));
    let mismatch = 0;
    for (const f of back.fixtures) {
      const origin = byId.get(f.id);
      if (!origin) continue;
      if (origin.homeId !== f.homeId || origin.awayId !== f.awayId) mismatch++;
      if (origin.result?.homeGoals !== f.result?.homeGoals) mismatch++;
      if (origin.result?.awayGoals !== f.result?.awayGoals) mismatch++;
    }
    expect(mismatch).toBe(0);

    const natById = new Map(finished.nationalFixtures.map((f) => [f.id, f]));
    for (const f of back.nationalFixtures) {
      const origin = natById.get(f.id);
      if (!origin) continue;
      expect([f.homeId, f.awayId]).toEqual([origin.homeId, origin.awayId]);
    }
    expect(saveSizeKB(save)).toBeLessThanOrEqual(BALANCE.saveMaxKB);
  });

  it('结算态读档后积分榜与赛果自洽（冠军仍在榜首）', { timeout: 180000 }, () => {
    const session = newGame({ seed: SEED, mode: 'manager', manager: { clubId: 'eng-t1-01' } });
    const finished = finishSeason(simulateSeason(session.world));
    const back = decodeSave(encodeSave(finished, session.state)).world;
    const champ = finished.lastSeasonChampions['eng-l1'];
    expect(back.standings['eng-l1']?.rows[0]?.clubId).toBe(champ);
  });

  it('赛果列里的非法字符按未赛修复，不抛异常', () => {
    const session = newGame({ seed: SEED, mode: 'manager', manager: { clubId: 'eng-t1-01' } });
    const save = encodeSave(session.world, session.state);
    const dirty = JSON.parse(JSON.stringify(save)) as SaveGame;
    dirty.delta.clubResults.home = `Z${'Z'.repeat(Math.max(0, dirty.delta.clubResults.home.length - 1))}`;
    const loaded = loadSave(dirty);
    expect(loaded.ok).toBe(true);
    expect(loaded.repaired.some((r) => r.includes('非法字符'))).toBe(true);
  });

  it('未知版本号显式拒绝，不静默按当前版本解码', () => {
    const session = newGame({ seed: SEED, mode: 'manager', manager: { clubId: 'eng-t1-01' } });
    const save = encodeSave(session.world, session.state) as SaveGame & { version: number };
    save.version = BALANCE.saveVersion + 1;
    const loaded = loadSave(save);
    expect(loaded.ok).toBe(false);
    expect(loaded.reason ?? '').toContain('版本');
  });
});
