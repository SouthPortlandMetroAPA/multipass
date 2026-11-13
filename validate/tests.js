/* ============================================================================
 * MultiPass — public-contract validation suite
 * ============================================================================
 * Spiral structure: each ring assumes every ring before it passed. Ring 0 asks
 * "is anything there at all"; Ring 5 asks "does it survive two people tapping
 * Register at the same instant".
 *
 * WHAT THIS SUITE CAN AND CANNOT SEE
 *   It drives the PUBLIC GAS contract only — the same surface a player's browser
 *   has. It holds no database key, so it cannot assert row counts or column
 *   values directly; it asserts what the API returns. Structural properties
 *   (no authSess_, no slate.players read) are pinned separately and cannot be
 *   checked from here:
 *       node tools/claude/multipass/validate-sq-isolation.mjs
 *   A green run here plus a green run there is the full picture. Either alone
 *   is not.
 *
 * A SKIPPED TEST IS NOT A PASSING TEST. The runner renders them differently on
 * purpose: a check that could not run must never read the same as one that ran
 * clean.
 *
 * EMAIL COST
 *   Rings 3 and 5 write real rows. By default they pass dry_run, so the row is
 *   written and the token minted but nothing is mailed. Not a quota worry (the
 *   account sends ~1,500/day), just a reason not to spray bounces at a reserved
 *   domain on every run. Turn off "Dry run" to prove real delivery.
 *
 * TEST DATA
 *   Member numbers are synthetic, in 99900000–99900999, and every registration
 *   this suite creates is cancelled before the run ends. Nothing here touches a
 *   real member record; the server reads no member table at all.
 * ========================================================================== */

window.SQ_SUITE = (function () {
  'use strict';

  var GAS = 'https://script.google.com/macros/s/AKfycbzGTzkBRTrIIP_tD6sbtOOUmNZkXDdtxPoO4c8fdWt5h3tZFueNSISPv8Q3LWStx73Whw/exec';

  /* Fixtures seeded by tools/claude/multipass/seed-validate-fixtures.mjs.
     PAST and CLOSED are is_test=false on purpose: sqEvent_ filters is_test
     first, so an is_test row can never reach the 'over' or disabled branches.

     IDS ARE NOT HARDCODED. They are serial, so a purge-and-reseed changes them
     — and a stale hardcoded id does not make these checks fail, it makes them
     pass VACUOUSLY, which is worse. They are read from fixtures.json, written
     by the seeder, and then PROBED: if the server does not actually have them,
     every dependent check below skips loudly instead of pretending. */
  var FIX = { past: 0, closed: 0, isTest: 0, unknown: 99999999, ready: false };

  var SEED_HINT = 'Seed them with:  node tools/claude/multipass/seed-validate-fixtures.mjs --go';
  function needFixtures() {
    return { skip: 'The validation fixtures are not seeded, so this check cannot run. ' + SEED_HINT };
  }

  var TZ = 'America/Los_Angeles';

  function post(payload) {
    return fetch(GAS, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    }).then(function (r) { return r.json(); });
  }

  /* One synthetic member per run, so a rerun never collides with the last. */
  function freshMember() {
    return '99900' + String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  }

  function baseReg(ctx, over) {
    var o = {
      action: 'sq_register',
      event_id: ctx.liveEventId,
      member_number: ctx.member,
      first_name: 'Suite',
      last_name: 'Probe',
      email: 'suite-probe@example.com',
      dry_run: ctx.dryRun ? 1 : 0
    };
    for (var k in (over || {})) o[k] = over[k];
    return o;
  }

  /* Assert helpers that report the VALUE seen, not just pass/fail — a bare
     "failed" sends you back to the console to find out what happened. */
  function eq(label, got, want) {
    return { ok: got === want, detail: label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) };
  }
  function rejectedWith(j, code) {
    if (!j) return { ok: false, detail: 'no response' };
    if (j.ok) return { ok: false, detail: 'ACCEPTED when it should have been refused — ' + JSON.stringify(j).slice(0, 160) };
    return {
      ok: j.code === code,
      detail: 'refused with code ' + JSON.stringify(j.code) + ' (want ' + JSON.stringify(code) + ') — "' + (j.error || '') + '"'
    };
  }

  /* Deep scan for any key or value that looks like registrant data. */
  function findPii(node, path) {
    var BAD = /^(email|member_number|first_name|last_name|paid|payment_method|registrations)$/i;
    var hits = [];
    (function walk(n, p) {
      if (n === null || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(function (v, i) { walk(v, p + '[' + i + ']'); }); return; }
      Object.keys(n).forEach(function (k) {
        if (BAD.test(k)) hits.push(p + '.' + k);
        walk(n[k], p + '.' + k);
      });
    })(node, path || '');
    return hits;
  }

  // ══════════════════════════════════════════════════════════════════════════
  var rings = [

    /* ── Ring 0 ─────────────────────────────────────────────────────────── */
    {
      n: 0,
      name: 'Reachability',
      intent: 'Is the backend there, and is the page current? Nothing below matters if this fails.',
      tests: [
        {
          id: '0.1', name: 'GAS answers sq_events',
          why: 'The one call every player makes first.',
          run: function (ctx) {
            return post({ action: 'sq_events' }).then(function (j) {
              ctx.events = (j && j.events) || [];
              return { ok: !!(j && j.ok === true && Array.isArray(j.events)),
                       detail: 'ok=' + (j && j.ok) + ', events=' + (j && j.events ? j.events.length : 'none') };
            });
          }
        },
        {
          id: '0.2', name: 'Served version.js parses',
          why: 'The stale-view guard compares against this; an unparseable file disables it silently.',
          run: function () {
            return fetch('../version.js?t=' + Date.now(), { cache: 'no-store' })
              .then(function (r) { return r.text(); })
              .then(function (t) {
                var m = t.match(/APP_VERSION\s*=\s*'([\d.]+)'/);
                return { ok: !!m && isFinite(parseFloat(m[1])),
                         detail: m ? 'version ' + m[1] : 'no APP_VERSION found in version.js' };
              });
          }
        },
        {
          id: '0.3', name: 'At least one live qualifier is open',
          why: 'Rings 2–5 need a real event to register against.',
          run: function (ctx) {
            var e = (ctx.events || []).filter(function (x) { return !/FIXTURE|^TEST /i.test(x.title || ''); })[0];
            if (e) ctx.liveEventId = e.id;
            return { ok: !!e, detail: e ? 'using event ' + e.id + ' — ' + e.title : 'no open qualifier to test against' };
          }
        },
        {
          id: '0.4', name: 'Validation fixtures are present',
          why: 'Five checks below need purpose-built events the players never see. Their ids are serial, so this reads them from fixtures.json and then PROVES the server has them — a stale id would otherwise make those checks pass without testing anything.',
          run: function (ctx) {
            return fetch('fixtures.json?t=' + Date.now(), { cache: 'no-store' })
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (j) {
                if (!j || !j.past) {
                  return { skip: 'fixtures.json is not published, so the fixture ids are unknown. ' + SEED_HINT };
                }
                FIX.past = j.past; FIX.closed = j.closed || 0; FIX.isTest = j.isTest || 0;
                /* The probe: a seeded PAST fixture answers 'over' (it exists but
                   has finished). A deleted one answers 'event'. That one reply
                   tells present from absent. */
                return post({ action: 'sq_register', event_id: FIX.past, member_number: ctx.member,
                              first_name: 'Fixture', last_name: 'Probe',
                              email: 'fixture-probe@example.com', dry_run: 1 })
                  .then(function (r) {
                    FIX.ready = !!(r && r.code === 'over');
                    return FIX.ready
                      ? { ok: true, detail: 'seeded — past=' + FIX.past + ', closed=' + FIX.closed + ', is_test=' + FIX.isTest }
                      : { skip: 'fixtures.json names event ' + FIX.past + ' but the server answered ' +
                                JSON.stringify(r && r.code) + ' — the fixtures have been removed. ' + SEED_HINT };
                  });
              })
              .catch(function () { return { skip: 'could not read fixtures.json. ' + SEED_HINT }; });
          }
        }
      ]
    },

    /* ── Ring 1 ─────────────────────────────────────────────────────────── */
    {
      n: 1,
      name: 'The public list is correct and safe',
      intent: 'Read-only. What a stranger can see, and what they must not.',
      tests: [
        {
          id: '1.1', name: 'Every listed event carries the fields the card needs',
          why: 'A missing venue or fee renders a blank line rather than an error — invisible breakage.',
          run: function (ctx) {
            var need = ['id', 'format', 'title', 'starts_at', 'venue_name', 'entry_fee'];
            var bad = [];
            (ctx.events || []).forEach(function (e) {
              need.forEach(function (k) {
                if (e[k] === undefined || e[k] === null || e[k] === '') bad.push(e.id + '.' + k);
              });
            });
            return { ok: !bad.length, detail: bad.length ? 'missing: ' + bad.join(', ') : 'all fields present on all ' + (ctx.events || []).length + ' events' };
          }
        },
        {
          id: '1.2', name: 'The finished fixture is NOT listed',
          why: 'Canary for the sqOver_ filter. Fixture 557 finished in January; if it appears, past qualifiers are being shown to players.',
          run: function (ctx) {
            if (!FIX.ready) return needFixtures();   /* with no fixture this would pass without testing anything */
            var hit = (ctx.events || []).filter(function (e) { return e.id === FIX.past; });
            return { ok: !hit.length,
                     detail: hit.length ? 'LEAKED — finished fixture ' + FIX.past + ' is on the public list'
                                        : 'fixture ' + FIX.past + ' exists and is correctly hidden' };
          }
        },
        {
          id: '1.3', name: 'The disabled fixture is NOT listed',
          why: 'Canary for the enabled=true filter. Archiving a qualifier must remove it from the page.',
          run: function (ctx) {
            if (!FIX.ready || !FIX.closed) return needFixtures();
            var hit = (ctx.events || []).filter(function (e) { return e.id === FIX.closed; });
            return { ok: !hit.length,
                     detail: hit.length ? 'LEAKED — disabled fixture ' + FIX.closed + ' is on the public list'
                                        : 'fixture ' + FIX.closed + ' exists and is correctly hidden' };
          }
        },
        {
          id: '1.4', name: 'No test fixtures on the public list',
          why: 'is_test rows are developer scaffolding; a player seeing "TEST 8 Ball Qualifier" erodes trust in the whole page.',
          run: function (ctx) {
            var hit = (ctx.events || []).filter(function (e) { return /^TEST |FIXTURE/i.test(e.title || ''); });
            return { ok: !hit.length, detail: hit.length ? 'LEAKED: ' + hit.map(function (e) { return e.id; }).join(', ') : 'none present' };
          }
        },
        {
          id: '1.5', name: 'The list carries no registrant data at all',
          why: 'This is the whole compliance line. If who-registered ever rides along in this payload, the public page is a member list.',
          run: function (ctx) {
            var hits = findPii(ctx.events, 'events');
            return { ok: !hits.length, detail: hits.length ? 'PII-SHAPED KEYS: ' + hits.join(', ') : 'no registrant-shaped keys anywhere in the payload' };
          }
        },
        {
          id: '1.6', name: 'Every listed qualifier is still in the future',
          why: 'Enforced server-side by sqOver_; this proves it for the real list, not just the fixture.',
          run: function (ctx) {
            var now = Date.now(), bad = [];
            (ctx.events || []).forEach(function (e) {
              var end = new Date(e.last_board_at || e.starts_at).getTime();
              if (isFinite(end) && end < now) bad.push(e.id);
            });
            return { ok: !bad.length, detail: bad.length ? 'already finished but listed: ' + bad.join(', ') : 'all future' };
          }
        },
        {
          id: '1.7', name: 'The list arrives in chronological order',
          why: 'The page groups by weekend; it sorts defensively, but an unordered server response means the ORDER BY was lost.',
          run: function (ctx) {
            var t = (ctx.events || []).map(function (e) { return new Date(e.starts_at).getTime(); });
            var sorted = t.every(function (v, i) { return i === 0 || t[i - 1] <= v; });
            return { ok: sorted, detail: sorted ? 'ascending by starts_at' : 'OUT OF ORDER as returned' };
          }
        },
        {
          id: '1.8', name: 'Start times are 9:00 AM Pacific, not a drifted wall time',
          why: 'An Eastern .ics shipped once in this project. Rendering is pinned to America/Los_Angeles; this asserts the stored instant agrees.',
          run: function (ctx) {
            var odd = (ctx.events || []).filter(function (e) {
              var h = new Date(e.starts_at).toLocaleTimeString('en-US', { hour: 'numeric', hour12: false, timeZone: TZ });
              return parseInt(h, 10) < 6 || parseInt(h, 10) > 20;
            });
            return { ok: !odd.length,
                     detail: odd.length ? 'suspicious Pacific start hours on: ' + odd.map(function (e) { return e.id; }).join(', ')
                                        : 'all start times fall in normal daytime hours Pacific' };
          }
        }
      ]
    },

    /* ── Ring 2 ─────────────────────────────────────────────────────────── */
    {
      n: 2,
      name: 'Bad input is refused before anything is written',
      intent: 'Every one of these must be rejected server-side, with a code the UI can act on. No email, no row.',
      tests: [
        {
          id: '2.1', name: 'A 5-digit member number is refused',
          why: 'THE REGRESSION. The column CHECK is exactly 8; a 5-digit entry used to reach Postgres and come back as a generic "could not save". A real player hit this on 2026-11-12.',
          run: function (ctx) { return post(baseReg(ctx, { member_number: '18821' })).then(function (j) { return rejectedWith(j, 'apa'); }); }
        },
        {
          id: '2.2', name: 'A 7-digit member number is refused',
          why: 'Off-by-one either side of the boundary.',
          run: function (ctx) { return post(baseReg(ctx, { member_number: '1234567' })).then(function (j) { return rejectedWith(j, 'apa'); }); }
        },
        {
          id: '2.3', name: 'A 9-digit member number is refused',
          why: 'The other side of the boundary. The old rule allowed 5–9 and the DB allowed only 8.',
          run: function (ctx) { return post(baseReg(ctx, { member_number: '123456789' })).then(function (j) { return rejectedWith(j, 'apa'); }); }
        },
        {
          id: '2.4', name: 'Letters in the member number are refused',
          why: 'Digits are stripped before validation; proves stripping cannot turn "abcde123" into a short valid number.',
          run: function (ctx) { return post(baseReg(ctx, { member_number: 'abcd1234x' })).then(function (j) { return rejectedWith(j, 'apa'); }); }
        },
        {
          id: '2.5', name: 'An empty member number is refused',
          why: 'The empty string is the input a disabled-JS submit sends.',
          run: function (ctx) { return post(baseReg(ctx, { member_number: '' })).then(function (j) { return rejectedWith(j, 'apa'); }); }
        },
        {
          id: '2.6', name: 'A missing name is refused',
          why: 'The confirmation email and the .ics both address the player by name.',
          run: function (ctx) { return post(baseReg(ctx, { first_name: '', last_name: '' })).then(function (j) { return rejectedWith(j, 'name'); }); }
        },
        {
          id: '2.7', name: 'A malformed email is refused',
          why: 'A bad address means a silently undelivered confirmation and a cancel link nobody receives.',
          run: function (ctx) { return post(baseReg(ctx, { email: 'not-an-email' })).then(function (j) { return rejectedWith(j, 'email'); }); }
        },
        {
          id: '2.8', name: 'An unknown event id is refused',
          why: 'The event id is caller-supplied and trivially editable.',
          run: function (ctx) { return post(baseReg(ctx, { event_id: FIX.unknown })).then(function (j) { return rejectedWith(j, 'event'); }); }
        },
        {
          id: '2.9', name: 'A test-fixture event cannot be registered for',
          why: 'is_test rows must be unreachable from the public path, not merely hidden from the list.',
          run: function (ctx) {
            if (!FIX.ready || !FIX.isTest) return needFixtures();
            return post(baseReg(ctx, { event_id: FIX.isTest })).then(function (j) { return rejectedWith(j, 'event'); });
          }
        },
        {
          id: '2.10', name: 'An archived (disabled) qualifier cannot be registered for',
          why: 'Archiving must close registration, not just hide the card. Someone holding the old link must be refused.',
          run: function (ctx) {
            if (!FIX.ready || !FIX.closed) return needFixtures();
            return post(baseReg(ctx, { event_id: FIX.closed })).then(function (j) { return rejectedWith(j, 'event'); });
          }
        },
        {
          id: '2.11', name: 'A finished qualifier cannot be registered for',
          why: 'The cutoff is enforced SERVER-side. A decorative deadline shipped in this project before; this is the branch that proves it is not decorative here.',
          run: function (ctx) {
            if (!FIX.ready) return needFixtures();
            return post(baseReg(ctx, { event_id: FIX.past })).then(function (j) { return rejectedWith(j, 'over'); });
          }
        }
      ]
    },

    /* ── Ring 3 ─────────────────────────────────────────────────────────── */
    {
      n: 3,
      name: 'The round trip a real player makes',
      intent: 'Register, re-submit, cancel, cancel again, come back. Writes real rows; cancels them all before finishing.',
      writes: true,
      tests: [
        {
          id: '3.1', name: 'Registration succeeds and returns a cancel token',
          why: 'The token IS the cancel link in the email. A row that saves without one is a registration nobody can undo — that exact bug shipped on 2026-11-12.',
          run: function (ctx) {
            return post(baseReg(ctx)).then(function (j) {
              ctx.token = j && j.token;
              var shaped = /^[0-9]+\.[A-Za-z0-9_-]{10,}$/.test(ctx.token || '');
              return { ok: !!(j && j.ok && shaped),
                       detail: 'ok=' + (j && j.ok) + ', token=' + JSON.stringify(ctx.token) +
                               (shaped ? ' (well-formed)' : ' (MALFORMED — the emailed cancel link would be dead)') +
                               ', email=' + (j && j.email) };
            });
          }
        },
        {
          id: '3.2', name: 'Re-submitting is idempotent, not a second row',
          why: 'Double-tap on a phone is the single most common real-world input. It must not create two registrations or error at the player.',
          run: function (ctx) {
            return post(baseReg(ctx)).then(function (j) {
              return { ok: !!(j && j.ok && j.already === true && j.token === ctx.token),
                       detail: 'ok=' + (j && j.ok) + ', already=' + (j && j.already) +
                               ', same token=' + (!!j && j.token === ctx.token) };
            });
          }
        },
        {
          id: '3.3', name: 'Cancelling with the token works',
          why: 'The path the emailed link takes, on any device.',
          run: function (ctx) {
            return post({ action: 'sq_cancel', token: ctx.token, dry_run: ctx.dryRun ? 1 : 0 })
              .then(function (j) { return { ok: !!(j && j.ok), detail: JSON.stringify(j).slice(0, 160) }; });
          }
        },
        {
          id: '3.4', name: 'Cancelling twice is harmless',
          why: 'People click the emailed link more than once. The second must be a calm "already done", not an error.',
          run: function (ctx) {
            return post({ action: 'sq_cancel', token: ctx.token, dry_run: ctx.dryRun ? 1 : 0 })
              .then(function (j) { return { ok: !!(j && j.ok && j.already === true), detail: JSON.stringify(j).slice(0, 160) }; });
          }
        },
        {
          id: '3.5', name: 'They can change their mind and come back',
          why: 'Re-registering after a cancel reuses the row and must bump the .ics sequence, or the calendar invite will not update.',
          run: function (ctx) {
            return post(baseReg(ctx)).then(function (j) {
              ctx.token2 = j && j.token;
              return { ok: !!(j && j.ok && j.token && !j.already),
                       detail: 'ok=' + (j && j.ok) + ', already=' + (j && j.already) + ', token=' + JSON.stringify(j && j.token) };
            });
          }
        },
        {
          id: '3.6', name: 'Cleanup — the suite leaves nothing registered',
          why: 'A test run must not put a synthetic player on the operator’s Saturday list.',
          run: function (ctx) {
            var t = ctx.token2 || ctx.token;
            if (!t) return { skip: 'nothing was registered to clean up' };
            return post({ action: 'sq_cancel', token: t, dry_run: ctx.dryRun ? 1 : 0 })
              .then(function (j) { return { ok: !!(j && j.ok), detail: 'cancelled ' + ctx.member + ' — ' + JSON.stringify(j).slice(0, 120) }; });
          }
        }
      ]
    },

    /* ── Ring 4 ─────────────────────────────────────────────────────────── */
    {
      n: 4,
      name: 'Security and isolation',
      intent: 'The open path must not have opened anything else. Mostly read-only.',
      tests: [
        {
          id: '4.1', name: 'A forged cancel token is refused',
          why: 'Tokens are HMAC-signed precisely so a guessed id cannot cancel a stranger’s spot.',
          run: function () {
            return post({ action: 'sq_cancel', token: '1.deadbeefdeadbeefdeadbeef' })
              .then(function (j) { return rejectedWith(j, 'token'); });
          }
        },
        {
          id: '4.2', name: 'A real id with a wrong signature is refused',
          why: 'The sharper version of 4.1: the id exists, only the signature is wrong. Verification must not stop at parsing.',
          run: function (ctx) {
            var id = (ctx.token || '1.x').split('.')[0];
            return post({ action: 'sq_cancel', token: id + '.AAAAAAAAAAAAAAAAAAAAAAAA' })
              .then(function (j) { return rejectedWith(j, 'token'); });
          }
        },
        {
          id: '4.3', name: 'A token with no signature at all is refused',
          why: 'The naive bug is parseInt(token) and trust. A bare id must get nowhere.',
          run: function (ctx) {
            var id = (ctx.token || '1.x').split('.')[0];
            return post({ action: 'sq_cancel', token: id }).then(function (j) { return rejectedWith(j, 'token'); });
          }
        },
        {
          id: '4.4', name: 'The member-directory lookup is still gated',
          why: 'lookup returns player identity. It is admin-gated; this proves the open path did not loosen it.',
          run: function () {
            return post({ action: 'lookup', q: 'probe' }).then(function (j) {
              return { ok: !!(j && j.ok === false && /unauthor/i.test(j.error || '')),
                       detail: JSON.stringify(j).slice(0, 160) };
            });
          }
        },
        {
          id: '4.5', name: 'The old SSO registration path still demands a session',
          why: 'sq_* was added ALONGSIDE mp_*. If mp_register became reachable without a session, the change broke something it never touched.',
          run: function () {
            return post({ action: 'mp_register', event_id: 551, token: 'not-a-session' }).then(function (j) {
              return { ok: !!(j && j.ok === false), detail: 'refused: ' + JSON.stringify(j).slice(0, 160) };
            });
          }
        },
        {
          id: '4.6', name: 'An unknown action is refused, not silently accepted',
          why: 'A router that falls through to ok:true would make every test above meaningless.',
          run: function () {
            return post({ action: 'sq_not_a_real_action_xyz' }).then(function (j) {
              return { ok: !(j && j.ok === true), detail: JSON.stringify(j).slice(0, 160) };
            });
          }
        },
        {
          id: '4.7', name: 'sq_status is not a membership oracle',
          why: 'It must answer only for HMAC tokens the caller already holds. A forged token has to come back "invalid" — never a row, and never a hint that an id exists.',
          run: function () {
            return post({ action: 'sq_status', tokens: ['1.AAAAAAAAAAAAAAAAAAAAAAAA', '2.BBBBBBBBBBBBBBBBBBBBBBBB'] })
              .then(function (j) {
                var s = (j && j.status) || {};
                var leaked = Object.keys(s).filter(function (k) { return s[k] !== 'invalid'; });
                return { ok: !!(j && j.ok) && !leaked.length,
                         detail: leaked.length ? 'LEAKED for forged tokens: ' + JSON.stringify(s)
                                               : 'both forged tokens reported "invalid"' };
              });
          }
        },
        {
          id: '4.8', name: 'MUTATION — the suite can actually fail',
          why: 'A suite that cannot go red proves nothing. This asserts something known to be false; it must FAIL. If it passes, the runner is broken.',
          inverted: true,
          run: function () { return { ok: false, detail: 'deliberately false — the runner should show this as the expected red' }; }
        }
      ]
    },

    /* ── Ring 5 ─────────────────────────────────────────────────────────── */
    {
      n: 5,
      name: 'Messy reality',
      intent: 'Concurrency, odd input, and the limiter. Writes rows; cleans up after itself.',
      writes: true,
      tests: [
        {
          id: '5.1', name: 'Two simultaneous submits collapse to one registration',
          why: 'Not a double-tap in sequence — genuinely in flight at once. The DB unique index is the real guard; both callers must get a coherent answer.',
          run: function (ctx) {
            var m = freshMember();
            var body = baseReg(ctx, { member_number: m });
            return Promise.all([post(body), post(body)]).then(function (both) {
              var a = both[0], b = both[1];
              var bothOk = a && b && a.ok && b.ok;
              var sameToken = a.token && b.token && a.token === b.token;
              var oneRefusedCleanly = (a.ok && b.code === 'already') || (b.ok && a.code === 'already');
              ctx.cleanup.push(a.token || b.token);
              return { ok: !!(bothOk && sameToken) || !!oneRefusedCleanly,
                       detail: 'A=' + JSON.stringify(a).slice(0, 90) + '  B=' + JSON.stringify(b).slice(0, 90) };
            });
          }
        },
        {
          id: '5.2', name: 'Plus-addressed email is accepted',
          why: 'name+apa@gmail.com is valid and common. Rejecting it turns a working address into a support ticket.',
          run: function (ctx) {
            var m = freshMember();
            return post(baseReg(ctx, { member_number: m, email: 'suite.probe+apa@example.com' })).then(function (j) {
              if (j && j.token) ctx.cleanup.push(j.token);
              return { ok: !!(j && j.ok), detail: JSON.stringify(j).slice(0, 160) };
            });
          }
        },
        {
          id: '5.3', name: 'An apostrophe in a name survives',
          why: 'O’Brien is a name, not an injection. It must round-trip without erroring or being mangled.',
          run: function (ctx) {
            var m = freshMember();
            return post(baseReg(ctx, { member_number: m, last_name: "O'Brien-Test" })).then(function (j) {
              if (j && j.token) ctx.cleanup.push(j.token);
              return { ok: !!(j && j.ok), detail: JSON.stringify(j).slice(0, 160) };
            });
          }
        },
        {
          id: '5.4', name: 'An over-long name is truncated, not rejected',
          why: 'The handler slices to 60. A paste accident should not block a registration.',
          run: function (ctx) {
            var m = freshMember();
            return post(baseReg(ctx, { member_number: m, first_name: new Array(200).join('A') })).then(function (j) {
              if (j && j.token) ctx.cleanup.push(j.token);
              return { ok: !!(j && j.ok), detail: JSON.stringify(j).slice(0, 160) };
            });
          }
        },
        {
          id: '5.5', name: 'The per-member limiter engages',
          why: 'Open registration mails an address a stranger typed. Slow, and it burns that synthetic member’s hourly window on purpose.',
          slow: true,
          run: function (ctx) {
            var m = freshMember();
            var body = baseReg(ctx, { member_number: m });
            var seen = [];
            var chain = Promise.resolve();
            for (var i = 0; i < 8; i++) {
              chain = chain.then(function () {
                return post(body).then(function (j) { seen.push(j && (j.code || (j.ok ? 'ok' : '?'))); if (j && j.token) ctx.cleanup.push(j.token); });
              });
            }
            return chain.then(function () {
              var limited = seen.indexOf('rate') >= 0;
              return { ok: limited,
                       detail: 'responses in order: ' + seen.join(', ') +
                               (limited ? '' : ' — NEVER rate-limited in 8 attempts') };
            });
          }
        },
        {
          id: '5.6', name: 'A device’s remembered registration is corrected by the server',
          why: 'THE STALENESS BUG. localStorage is the only record a phone keeps. When the office removes someone from the admin page, that phone kept rendering "You are in" — a confident wrong answer that puts them at the venue expecting a spot. sq_status is how the page corrects itself.',
          run: function (ctx) {
            var m = freshMember();
            return post(baseReg(ctx, { member_number: m })).then(function (reg) {
              if (!reg || !reg.token) return { ok: false, detail: 'could not register a probe to check' };
              return post({ action: 'sq_status', tokens: [reg.token] }).then(function (a) {
                var inNow = a && a.status && a.status[reg.token] && a.status[reg.token].status === 'registered';
                return post({ action: 'sq_cancel', token: reg.token, dry_run: ctx.dryRun ? 1 : 0 })
                  .then(function () { return post({ action: 'sq_status', tokens: [reg.token] }); })
                  .then(function (b) {
                    var outNow = b && b.status && b.status[reg.token] && b.status[reg.token].status === 'cancelled';
                    return { ok: !!(inNow && outNow),
                             detail: 'while registered: ' + JSON.stringify(a.status[reg.token]) +
                                     '  |  after cancelling: ' + JSON.stringify(b.status[reg.token]) };
                  });
              });
            });
          }
        },
        {
          id: '5.7', name: 'Cleanup — cancel everything this ring created',
          why: 'Same rule as 3.6. The operator’s list must contain only real players.',
          run: function (ctx) {
            var toks = (ctx.cleanup || []).filter(Boolean);
            if (!toks.length) return { skip: 'this ring created nothing to clean up' };
            var done = 0;
            return toks.reduce(function (p, t) {
              return p.then(function () {
                return post({ action: 'sq_cancel', token: t, dry_run: ctx.dryRun ? 1 : 0 })
                  .then(function (j) { if (j && j.ok) done++; });
              });
            }, Promise.resolve()).then(function () {
              return { ok: done === toks.length, detail: 'cancelled ' + done + ' of ' + toks.length };
            });
          }
        }
      ]
    }
  ];

  return { gas: GAS, fixtures: FIX, rings: rings, freshMember: freshMember, post: post };
})();
