/* -*- Mode: js2; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */

var EXPORTED_SYMBOLS = [ "firetray" ];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://firetray/ctypes/linux/gtk.jsm");
Cu.import("resource://firetray/commons.js");
firetray.Handler.subscribeLibsForClosing([gtk]);

if ("undefined" == typeof(firetray.StatusIcon))
  log.error("This module MUST be imported from/after StatusIcon !");

let log = firetray.Logging.getLogger("firetray.GtkIcons");


firetray.GtkIcons = {
  initialized: false,

  GTK_THEME_ICON_PATH: null,

  init: function() {
    try {
      if (this.initialized) return true;

      this.loadDefaultTheme();
      this.initialized = true;
      return true;
    } catch (x) {
      log.error(x);
      return false;
    }
  },

  shutdown: function() {
    this.initialized = false;
  },

  loadDefaultTheme: function() {
    this.GTK_THEME_ICON_PATH = firetray.Utils.chromeToPath("chrome://firetray/skin/linux/icons");
    let gtkIconTheme = gtk.gtk_icon_theme_get_default();
    gtk.gtk_icon_theme_append_search_path(gtkIconTheme, this.GTK_THEME_ICON_PATH);
  }

};
