import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const ICON = 'display-brightness-symbolic';
// GsmInhibitorFlag: 4 = suspend, 8 = idle (blank/lock/dim).
const INHIBIT_FLAGS = 4 | 8;

function sessionManagerCall(method, params, replyType) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(
            'org.gnome.SessionManager', '/org/gnome/SessionManager',
            'org.gnome.SessionManager', method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// Index in the right box just left of Quick Settings (or of the audio output
// switcher, so the two stay in the same order whatever loads first).
function panelIndex() {
    const rightBox = Main.panel._rightBox;
    const next = Main.panel.statusArea['audio-output@arjun']?.container
        ?? Main.panel.statusArea.quickSettings?.container;
    const idx = next ? rightBox.get_children().indexOf(next) : -1;
    return idx >= 0 ? idx : 0;
}

export default class KeepAwakePanel extends Extension {
    enable() {
        this._on = false;
        this._cookie = null;
        // Bumped on every change so a stale Inhibit reply gets undone.
        this._generation = 0;

        this._button = new PanelMenu.Button(0.5, this.metadata.name, true);
        this._button.add_style_class_name('keep-awake-panel');
        this._icon = new St.Icon({icon_name: ICON, style_class: 'system-status-icon', y_align: Clutter.ActorAlign.CENTER});
        this._button.add_child(this._icon);
        this._button.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._set(!this._on, true);
            return Clutter.EVENT_STOP;
        });
        this._button.connect('touch-event', (_a, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            this._set(!this._on, true);
            return Clutter.EVENT_STOP;
        });
        this._button.connect('key-press-event', (_a, event) => {
            const key = event.get_key_symbol();
            if (key !== Clutter.KEY_space && key !== Clutter.KEY_Return && key !== Clutter.KEY_KP_Enter)
                return Clutter.EVENT_PROPAGATE;
            this._set(!this._on, true);
            return Clutter.EVENT_STOP;
        });

        Main.panel.addToStatusArea(this.uuid, this._button, panelIndex(), 'right');
        this._sync();
    }

    _sync() {
        if (this._on)
            this._button.add_style_class_name('keep-awake-on');
        else
            this._button.remove_style_class_name('keep-awake-on');
        this._button.accessible_name = this._on ? 'Keep Awake: on' : 'Keep Awake: off';
    }

    async _set(on, showOsd) {
        this._on = on;
        const gen = ++this._generation;
        this._sync();
        if (showOsd) {
            Main.osdWindowManager.showAll(new Gio.ThemedIcon({name: ICON}),
                on ? 'Keep Awake on · screen stays on' : 'Keep Awake off', null, null);
        }

        if (this._cookie !== null) {
            const cookie = this._cookie;
            this._cookie = null;
            this._uninhibit(cookie);
        }
        if (!on)
            return;

        try {
            const reply = await sessionManagerCall('Inhibit',
                new GLib.Variant('(susu)', ['keep-awake-panel', 0, 'Keep Awake is on', INHIBIT_FLAGS]),
                '(u)');
            const [cookie] = reply.deepUnpack();
            if (gen === this._generation && this._on)
                this._cookie = cookie;
            else
                this._uninhibit(cookie);
        } catch (e) {
            console.error(`keep-awake-panel: Inhibit failed: ${e}`);
            if (gen === this._generation && this._button) {
                this._on = false;
                this._sync();
            }
        }
    }

    _uninhibit(cookie) {
        sessionManagerCall('Uninhibit', new GLib.Variant('(u)', [cookie]), null)
            .catch(e => console.error(`keep-awake-panel: Uninhibit failed: ${e}`));
    }

    disable() {
        this._generation++;
        if (this._cookie !== null)
            this._uninhibit(this._cookie);
        this._cookie = null;
        this._on = false;
        this._button?.destroy();
        this._button = null;
        this._icon = null;
    }
}
