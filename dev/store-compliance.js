'use strict';
// One-off: bring flow titles, manifest text, readme and changelog in line with
// the Homey App Store guidelines (no parentheses or when/then words in titles,
// explanations in hints, one-line tagline, plain-text README.txt).
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const en = s => ({ en: s });
const R = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const J = (p, o) => fs.writeFileSync(path.join(root, p), `${JSON.stringify(o, null, 2)}\n`);

const F = (d, id) => `.homeycompose/flow/${d}/${id}.json`;
const set = (d, id, title, hint, titleFormatted) => {
  const o = R(F(d, id));
  o.title = en(title);
  if (hint) o.hint = en(hint);
  if (titleFormatted) o.titleFormatted = en(titleFormatted);
  J(F(d, id), o);
};

set('triggers', 'system_armed', 'Armed away', 'The panel is now fully armed. Fires after the exit delay has finished.');
set('triggers', 'system_partially_armed', 'Armed home', 'The panel is now partially armed, for when people are at home.');
set('triggers', 'system_disarmed', 'Disarmed', 'The panel was disarmed, or an exit delay was cancelled.');
set('triggers', 'mode_changed', 'The mode changed', 'Fires after an exit delay has finished and the new mode is in effect. Use the dropdown to pick a specific mode.', 'The mode changed to [[mode]]');
set('triggers', 'arming_started', 'Exit delay started', 'An arm request was accepted and the exit countdown is running. Sensors that are open right now are in the Open sensors tag; they are checked again when the countdown ends.');
set('triggers', 'arming_blocked', 'Arming was blocked by open sensors', 'With the open-sensor policy set to block, a sensor was still open when the exit delay ended. The system stays in its previous mode.');
set('triggers', 'arming_warning', 'Armed while sensors were open', 'With the open-sensor policy set to warn, the system armed although sensors were still open at the end of the exit delay.');
set('triggers', 'entry_delay_started', 'The alarm was triggered', 'A delayed sensor tripped while armed and the entry countdown is running. The siren does not sound yet; disarm before the countdown ends to prevent it.');
set('triggers', 'alarm_triggered', 'The alarm started sounding', 'Fires after the entry delay, or immediately for sensors without delay. Linked sirens and keypads start at this moment.');
set('triggers', 'alarm_ended', 'The alarm stopped sounding', 'The alarm ended by disarming, by silencing it, or because the alarm duration ran out.');
set('triggers', 'countdown_tick', 'Countdown tick', 'Fires every second during an exit or entry delay. The Seconds tag holds the remaining time.', '[[type]] countdown ticks');
set('triggers', 'countdown_cancelled', 'Countdown cancelled', 'An exit or entry countdown was stopped before it finished.');
set('triggers', 'pin_accepted', 'A valid code was entered');
set('triggers', 'pin_rejected', 'An invalid code was entered');
set('triggers', 'panic', 'A panic code was entered', 'The user entered their code followed by the panic digits. The alarm was disarmed as usual and nothing was shown on screen; use this to notify someone silently.');
set('triggers', 'sensor_excluded_changed', 'A sensor was excluded or included');

set('conditions', 'mode_is', 'The mode is', null, 'The mode !{{is|is not}} [[mode]]');
set('conditions', 'alarm_active', 'The alarm !{{is|is not}} sounding');
set('conditions', 'alarm_pending', 'The alarm !{{is|is not}} triggered', 'True while the entry countdown runs, before the siren sounds.');
set('conditions', 'countdown_running', 'A countdown !{{is|is not}} running');
set('conditions', 'sensors_open', 'Sensors !{{are|are not}} open', null, 'Sensors for [[mode]] !{{are|are not}} open');
set('conditions', 'sensor_excluded', 'A sensor !{{is|is not}} excluded', null, '[[sensor]] !{{is|is not}} excluded');

set('actions', 'set_mode', 'Set the mode', 'Arming goes through the sensor check and exit delay. No code is needed from a flow.', 'Set the mode to [[mode]]');
set('actions', 'set_mode_with_pin', 'Set the mode with a code', 'For physical keypads: the code is verified against the users and the user name is available in the trigger tags.', 'Set the mode to [[mode]] with code [[pin]]');
set('actions', 'deactivate_alarm', 'Silence the alarm', 'Stops the siren but keeps the system armed.');
set('actions', 'trigger_alarm', 'Sound the alarm', null, 'Sound the alarm because [[reason]]');
set('actions', 'cancel_countdown', 'Cancel the running countdown');
set('actions', 'exclude_sensor', 'Exclude a sensor', 'Bypass the sensor: it no longer blocks arming or triggers the alarm, until it is included again. Its mode assignment is kept.', 'Exclude [[sensor]]');
set('actions', 'include_sensor', 'Include a sensor', null, 'Include [[sensor]]');
set('actions', 'keypad_entry', 'Handle a keypad entry', "Connect this to your keypad's code-entered trigger and pass its code and key tags. Keys such as DISARM_ALL, ARM_HOME, ARM_AWAY, ENTER and CANCEL, or Disarm, Home and Away, are understood. The code is checked against the users, including the panic digits.", 'Handle keypad entry with code [[pin]], key [[key]] from keypad [[keypad]]');

// Panel device cards
const pf = 'drivers/panel/driver.flow.compose.json';
const pd = R(pf);
const titles = {
  panel_armed: ['Armed away'], panel_partially_armed: ['Armed home'], panel_disarmed: ['Disarmed'],
  panel_exit_delay: ['Exit delay started'],
  panel_alarm_triggered: ['The alarm was triggered', 'A delayed sensor tripped and the entry countdown is running; the siren does not sound yet.'],
  panel_alarm_sounding: ['The alarm started sounding'], panel_alarm_stopped: ['The alarm stopped sounding'],
  panel_is_armed: ['!{{Is|Is not}} armed away'], panel_is_partially_armed: ['!{{Is|Is not}} armed home'], panel_is_disarmed: ['!{{Is|Is not}} disarmed'],
  panel_is_sounding: ['The alarm !{{is|is not}} sounding'], panel_is_triggered: ['The alarm !{{is|is not}} triggered', 'True while the entry countdown runs.'],
  panel_arm: ['Arm away'], panel_partially_arm: ['Arm home'], panel_disarm: ['Disarm'], panel_silence: ['Silence the alarm', 'Stops the siren but keeps the system armed.'],
};
for (const list of [pd.triggers, pd.conditions, pd.actions]) {
  for (const c of list) {
    const t = titles[c.id];
    if (t) { c.title = en(t[0]); if (t[1]) c.hint = en(t[1]); }
  }
}
J(pf, pd);

// Capability title
const cap = R('.homeycompose/capabilities/alarm_pending.json');
cap.title = en('Alarm pending');
J('.homeycompose/capabilities/alarm_pending.json', cap);

// Manifest: tagline, support, tags
const a = R('.homeycompose/app.json');
a.description = en('Your own alarm system with a code keypad, delays and sensors');
a.support = 'mailto:homey@refract.one';
a.tags = en(['alarm', 'security', 'keypad', 'pin', 'ring', 'panel', 'arm', 'disarm', 'siren']);
J('.homeycompose/app.json', a);

// Store readme: plain text, 1-2 paragraphs, no markdown, no URLs, no lists
fs.writeFileSync(path.join(root, 'README.txt'),
  'Security Panel turns the sensors you already have into a complete alarm system. Door, window and motion sensors arm and disarm in Away and Home mode, with an exit delay to leave the house and an entry delay to disarm when you come home. Every household member gets their own code, and a silent panic code quietly warns someone else while the alarm appears to disarm normally. A keypad widget on your dashboard shows the status and takes codes, and the Ring Keypad pairs directly with the app so its lights, countdown and siren follow the alarm.\n\n'
  + 'The app connects to the devices in your home to watch your sensors and to drive sirens and indicator lights, which is why it asks for access to the Homey API. Open the app settings to choose delays, which sensors count in which mode, users and codes, sirens, LED lights and which events appear on your timeline.\n');

// Changelog
J('.homeychangelog.json', { [a.version]: en('First release: alarm engine with delays, code keypad widget, Ring Keypad driver, sirens and LED indicators.') });

// Report leftovers
const paren = [];
for (const d of ['triggers', 'conditions', 'actions']) {
  for (const f of fs.readdirSync(path.join(root, `.homeycompose/flow/${d}`))) {
    const o = R(`.homeycompose/flow/${d}/${f}`);
    if (/[()]/.test(o.title.en)) paren.push(f);
  }
}
console.log('flow titles with parentheses left:', paren);
console.log('version', a.version, '| support', a.support);
