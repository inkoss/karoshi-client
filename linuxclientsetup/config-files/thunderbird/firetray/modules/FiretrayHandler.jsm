/* -*- Mode: js2; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */

var EXPORTED_SYMBOLS = [ "firetray" ];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/ctypes.jsm");
Cu.import("resource://firetray/commons.js");
Cu.import("resource://firetray/PrefListener.jsm");
Cu.import("resource://firetray/VersionChange.jsm");

/**
 * firetray namespace.
 */
if ("undefined" == typeof(firetray)) {
  var firetray = {};
};

let log = firetray.Logging.getLogger("firetray.Handler");

/**
 * Singleton object and abstraction for windows and tray icon management.
 */
// NOTE: modules work outside of the window scope. Unlike scripts in the
// chrome, modules don't have access to objects such as window, document, or
// other global functions
// (https://developer.mozilla.org/en/XUL_School/JavaScript_Object_Management)
firetray.Handler = {

  initialized: false,
  timers: {},
  inBrowserApp: false,
  inMailApp: false,
  appHasChat: false,
  appStarted: false,
  windows: {},
  windowsCount: 0,
  visibleWindowsCount: 0,
  observedTopics: {},
  ctypesLibs: {},               // {"lib1": lib1, "lib2": lib2}

  appId:      (function(){return Services.appinfo.ID;})(),
  appName:    (function(){return Services.appinfo.name;})(),
  xulVer:     (function(){return Services.appinfo.platformVersion;})(), // Services.vc.compare(xulVer,"2.0a")>=0
  runtimeABI: (function(){return Services.appinfo.XPCOMABI;})(),
  runtimeOS:  (function(){return Services.appinfo.OS;})(), // "WINNT", "Linux", "Darwin"
  addonRootDir: (function(){
    let uri = Services.io.newURI(Components.stack.filename, null, null);
    if (uri instanceof Ci.nsIFileURL) {
      return uri.file.parent.parent;
    }
    throw new Error("not resolved");
  })(),

  init: function() {            // does creates icon
    firetray.PrefListener.register(false);
    firetray.MailChatPrefListener.register(false);

    // version checked during install, so we shouldn't need to care
    log.info("OS=" + this.runtimeOS + ", ABI=" + this.runtimeABI + ", XULrunner=" + this.xulVer);
    switch (this.runtimeOS) {
    case "Linux":
      Cu.import("resource://firetray/linux/FiretrayStatusIcon.jsm");
      Cu.import("resource://firetray/linux/FiretrayWindow.jsm");
      break;
    default:
      log.error("FIRETRAY: only Linux platform supported at this time. Firetray not loaded");
      return false;
    }

    if (this.appId === FIRETRAY_APP_DB['thunderbird']['id'] ||
        this.appId === FIRETRAY_APP_DB['seamonkey']['id'])
      this.inMailApp = true;
    if (this.appId === FIRETRAY_APP_DB['firefox']['id'] ||
        this.appId === FIRETRAY_APP_DB['seamonkey']['id'])
      this.inBrowserApp = true;
    if (this.appId === FIRETRAY_APP_DB['thunderbird']['id'] &&
        Services.vc.compare(this.xulVer,"15.0")>=0)
      this.appHasChat = true;
    log.info('inMailApp='+this.inMailApp+', inBrowserApp='+this.inBrowserApp+
      ', appHasChat='+this.appHasChat);

    firetray.Window.init();
    firetray.StatusIcon.init();
    firetray.Handler.showHideIcon();

    if (this.inMailApp) {
      try {
        Cu.import("resource:///modules/mailServices.js");
        Cu.import("resource://firetray/FiretrayMessaging.jsm");
        if (firetray.Utils.prefService.getBoolPref("mail_notification_enabled")) {
          firetray.Messaging.init();
          firetray.Messaging.updateMsgCountWithCb();
        }
      } catch (x) {
        log.error(x);
        return false;
      }
    }

    let chatIsProvided = this.isChatProvided();
    log.info('isChatProvided='+chatIsProvided);
    if (chatIsProvided) {
      Cu.import("resource://firetray/FiretrayMessaging.jsm"); // needed for existsChatAccount
      Cu.import("resource://firetray/FiretrayChat.jsm");
      firetray.Utils.addObservers(firetray.Handler, [
        "account-added", "account-removed"]);
      if (firetray.Utils.prefService.getBoolPref("chat_icon_enable") &&
          this.existsChatAccount())
        firetray.Chat.init();
    }

    firetray.Utils.addObservers(firetray.Handler,
      [ "xpcom-will-shutdown", "profile-change-teardown" ]);
    if (this.appId === FIRETRAY_APP_DB['firefox']['id'] ||
        this.appId === FIRETRAY_APP_DB['seamonkey']['id']) {
      firetray.Utils.addObservers(firetray.Handler, [ "sessionstore-windows-restored" ]);
    } else if (this.appId === FIRETRAY_APP_DB['thunderbird']['id']) {
      this.restoredWindowsCount = this.readTBRestoreWindowsCount();
      log.info("restoredWindowsCount="+this.restoredWindowsCount);
      if (!this.restoredWindowsCount) {
        log.error("session file could not be read");
        this.restoredWindowsCount = 1; // default
      }
      firetray.Utils.addObservers(firetray.Handler, [ "mail-startup-done" ]);
    } else {
      firetray.Utils.addObservers(firetray.Handler, [ "final-ui-startup" ]);
    }

    this.preventWarnOnClose();

    VersionChange.init(FIRETRAY_ID, FIRETRAY_VERSION, FIRETRAY_PREF_BRANCH);
    let vc = VersionChange, vch = firetray.VersionChangeHandler;
    vc.addHook(["install", "upgrade", "reinstall"], vch.showReleaseNotes);
    vc.addHook(["upgrade", "reinstall"], vch.tryEraseOldOptions);
    vc.addHook(["upgrade", "reinstall"], vch.correctMailNotificationType);
    vc.addHook(["upgrade", "reinstall"], vch.correctMailServerTypes);
    if (this.inMailApp) {
      vc.addHook(["upgrade", "reinstall"], firetray.Messaging.cleanExcludedAccounts);
    }
    vc.applyHooksAndWatchUninstall();

    this.initialized = true;
    return true;
  },

  shutdown: function() {
    if (firetray.Handler.isChatProvided() && firetray.Chat.initialized)
      firetray.Chat.shutdown();

    if (this.inMailApp)
      firetray.Messaging.shutdown();
    firetray.StatusIcon.shutdown();
    firetray.Window.shutdown();
    this.tryCloseLibs();

    firetray.Utils.removeAllObservers(this);

    firetray.MailChatPrefListener.unregister(false);
    firetray.PrefListener.unregister();

    this.appStarted = false;
    this.initialized = false;
    return true;
  },

  isChatEnabled: function() {
    return this.isChatProvided() &&
      firetray.Utils.prefService.getBoolPref("chat_icon_enable");
  },

  isChatProvided: function() {
    return this.appHasChat && Services.prefs.getBoolPref("mail.chat.enabled");
  },

  tryCloseLibs: function() {
    try {
      for (libName in this.ctypesLibs) {
        let lib = this.ctypesLibs[libName];
        if (lib.available())
          lib.close();
      };
    } catch(x) { log.error(x); }
  },

  subscribeLibsForClosing: function(libs) {
    for (let i=0, len=libs.length; i<len; ++i) {
      let lib = libs[i];
      if (!this.ctypesLibs.hasOwnProperty(lib.name))
        this.ctypesLibs[lib.name] = lib;
    }
  },

  readTBRestoreWindowsCount: function() {
    Cu.import("resource:///modules/IOUtils.js");
    let sessionFile = Services.dirsvc.get("ProfD", Ci.nsIFile);
    sessionFile.append("session.json");
    var initialState = null;
    if (sessionFile.exists()) {
      let data = IOUtils.loadFileToString(sessionFile);
      if (!data) return null;
      try {
        initialState = JSON.parse(data);
      } catch(x) {}
      if (!initialState) return null;

      return  initialState.windows.length;
    }
    return null;
  },

  // FIXME: this should definetely be done in Chat, but IM accounts
  // seem not be initialized at early stage (Exception... "'TypeError:
  // this._items is undefined' when calling method:
  // [nsISimpleEnumerator::hasMoreElements]"), and we're unsure if we should
  // initAccounts() ourselves...
  existsChatAccount: function() {
    let accounts = new firetray.Messaging.Accounts();
    for (let accountServer in accounts)
      if (accountServer.type === FIRETRAY_ACCOUNT_SERVER_TYPE_IM)  {
        return true;
      }

    return false;
  },

  startupDone: function() {
    firetray.Handler.timers['startup-done'] =
      firetray.Utils.timer(FIRETRAY_DELAY_STARTUP_MILLISECONDS,
        Ci.nsITimer.TYPE_ONE_SHOT, function() {
          firetray.Handler.appStarted = true;
          log.info("*** appStarted ***");

          if (firetray.Handler.inMailApp) {
            firetray.Messaging.addPrefObserver();
          }
        });
  },

  observe: function(subject, topic, data) {
    switch (topic) {

    case "sessionstore-windows-restored":
      // sessionstore-windows-restored does not come after the realization of
      // all windows... so we wait a little
    case "final-ui-startup":    // subject=ChromeWindow
      firetray.Utils.removeObservers(firetray.Handler, [ topic ]);
      firetray.Handler.startupDone();
      break;

    case "mail-startup-done": // or xul-window-visible, mail-tabs-session-restored ?
      if (firetray.Handler.restoredWindowsCount &&
          !--firetray.Handler.restoredWindowsCount) {
        firetray.Utils.removeObservers(firetray.Handler, [ topic ]);
        firetray.Handler.startupDone();
      }
      break;

    case "xpcom-will-shutdown":
      this.shutdown();
      break;
    case "profile-change-teardown": // also found "quit-application-granted"
      if (data === 'shutdown-persist')
        this.restoreWarnOnClose();
      break;

    case "account-removed":     // emitted by IM
      if (!this.existsChatAccount())
        firetray.Handler.toggleChat(false);
      break;
    case "account-added":       // emitted by IM
      if (!firetray.Chat.initialized)
        firetray.Handler.toggleChat(true);
      break;

    default:
      log.warn("unhandled topic: "+topic);
    }
  },

  toggleChat: function(enabled) {

    if (enabled) {
      firetray.Chat.init();
      for (let winId in firetray.Handler.windows) {
        firetray.Chat.attachSelectListeners(firetray.Handler.windows[winId].chromeWin);
      }

    } else {
      for (let winId in firetray.Handler.windows) {
        firetray.Chat.detachSelectListeners(firetray.Handler.windows[winId].chromeWin);
        firetray.ChatStatusIcon.detachOnFocusInCallback(winId);
      }
      firetray.Chat.shutdown();
    }
  },

  // these get overridden in OS-specific Icon/Window handlers
  setIconImageDefault: function() {},
  setIconImageNewMail: function() {},
  setIconImageFromFile: function(filename) {},
  setIconText: function(text, color) {},
  setIconTooltip: function(localizedMessage) {},
  setIconTooltipDefault: function() {},
  setIconVisibility: function(visible) {},
  registerWindow: function(win) {},
  unregisterWindow: function(win) {},
  getWindowIdFromChromeWindow: function(win) {},
  hideWindow: function(winId) {},
  showWindow: function(winId) {},
  showHideAllWindows: function() {},
  activateLastWindowCb: function(gtkStatusIcon, gdkEvent, userData) {},
  getActiveWindow: function() {},

  showAllWindows: function() {
    for (let winId in firetray.Handler.windows) {
      if (!firetray.Handler.windows[winId].visible)
        firetray.Handler.showWindow(winId);
    }
  },
  hideAllWindows: function() {
    for (let winId in firetray.Handler.windows) {
      if (firetray.Handler.windows[winId].visible)
        firetray.Handler.hideWindow(winId);
    }
  },

  showHideIcon: function() {
    if (firetray.Utils.prefService.getBoolPref('show_icon_on_hide'))
      firetray.Handler.setIconVisibility(
        (firetray.Handler.visibleWindowsCount !== firetray.Handler.windowsCount));
    else
      firetray.Handler.setIconVisibility(true);
  },

  /** nsIBaseWindow, nsIXULWindow, ... */
  getWindowInterface: function(win, iface) {
    let winInterface, winOut;
    try {                       // thx Neil Deakin !!
      winInterface =  win.QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIWebNavigation)
        .QueryInterface(Ci.nsIDocShellTreeItem)
        .treeOwner
        .QueryInterface(Ci.nsIInterfaceRequestor);
    } catch (ex) {
      // ignore no-interface exception
      log.error(ex);
      return null;
    }

    if (iface == "nsIBaseWindow")
      winOut = winInterface[iface];
    else if (iface == "nsIXULWindow")
      winOut = winInterface.getInterface(Ci.nsIXULWindow);
    else {
      log.error("unknown iface '" + iface + "'");
      return null;
    }

    return winOut;
  },

  _getBrowserProperties: function() {
    if (firetray.Handler.appId === FIRETRAY_APP_DB['firefox']['id'])
      return "chrome://branding/locale/browserconfig.properties";
    else if (firetray.Handler.appId === FIRETRAY_APP_DB['seamonkey']['id'])
      return "chrome://navigator-region/locale/region.properties";
    else return null;
  },

  _getHomePage: function() {
    var prefDomain = "browser.startup.homepage";
    var url;
    try {
      url = Services.prefs.getComplexValue(prefDomain,
        Components.interfaces.nsIPrefLocalizedString).data;
    } catch (e) {}

    // use this if we can't find the pref
    if (!url) {
      var SBS = Cc["@mozilla.org/intl/stringbundle;1"].getService(Ci.nsIStringBundleService);
      var configBundle = SBS.createBundle(firetray.Handler._getBrowserProperties());
      url = configBundle.GetStringFromName(prefDomain);
    }

    return url;
  },

  openPrefWindow: function() {
    if (null == firetray.Handler._preferencesWindow ||
        firetray.Handler._preferencesWindow.closed) {
      for(var first in firetray.Handler.windows) break;
      firetray.Handler._preferencesWindow =
        firetray.Handler.windows[first].chromeWin.openDialog(
          "chrome://firetray/content/options.xul", null,
          "chrome,titlebar,toolbar,centerscreen", null);
    }

    firetray.Handler._preferencesWindow.focus();
  },

  openBrowserWindow: function() {
    try {
      var home = firetray.Handler._getHomePage();

      // FIXME: obviously we need to wait to avoid seg fault on jsapi.cpp:827
      // 827         if (t->data.requestDepth) {
      firetray.Handler.timers['open-browser-window'] =
        firetray.Utils.timer(FIRETRAY_DELAY_NOWAIT_MILLISECONDS,
          Ci.nsITimer.TYPE_ONE_SHOT, function() {
            for(var first in firetray.Handler.windows) break;
            firetray.Handler.windows[first].chromeWin.open(home);
          });
    } catch (x) { log.error(x); }
  },

  openMailMessage: function() {
    try {
      var aURI = Services.io.newURI("mailto:", null, null);
      MailServices.compose.OpenComposeWindowWithURI(null, aURI);
    } catch (x) { log.error(x); }
  },

  quitApplication: function() {
    try {
      firetray.Handler.timers['quit-application'] =
        firetray.Utils.timer(FIRETRAY_DELAY_NOWAIT_MILLISECONDS,
          Ci.nsITimer.TYPE_ONE_SHOT, function() {
            let appStartup = Cc['@mozilla.org/toolkit/app-startup;1']
                  .getService(Ci.nsIAppStartup);
            appStartup.quit(Ci.nsIAppStartup.eAttemptQuit);
          });
    } catch (x) { log.error(x); }
  },

  preventWarnOnClose: function() {
    if (!this.inBrowserApp) return;
    let generalTabsPrefs = Services.prefs.getBranch("browser.tabs.");
    this.warnOnCloseTmp = generalTabsPrefs.getBoolPref('warnOnClose');
    generalTabsPrefs.setBoolPref('warnOnClose', false);
  },
  restoreWarnOnClose: function() {
    if (!this.inBrowserApp && !this.warnOnCloseTmp) return;
    let generalTabsPrefs = Services.prefs.getBranch("browser.tabs.");
    generalTabsPrefs.setBoolPref('warnOnClose', this.warnOnCloseTmp);
  }

}; // firetray.Handler


// FIXME: since prefs can also be changed from config editor, we need to
// 1. observe *all* firetray prefs, and 2. change options' UI accordingly !
firetray.PrefListener = new PrefListener(
  FIRETRAY_PREF_BRANCH,
  function(branch, name) {
    switch (name) {
    case 'hides_single_window':
      firetray.Handler.showHidePopupMenuItems();
      break;
    case 'show_icon_on_hide':
      firetray.Handler.showHideIcon();
      break;
    case 'mail_notification_enabled':
      if (firetray.Utils.prefService.getBoolPref('mail_notification_enabled')) {
        firetray.Messaging.init();
        firetray.Messaging.updateMsgCountWithCb();
      } else {
        firetray.Messaging.shutdown();
        firetray.Handler.setIconImageDefault();
      }
      break;
    case 'new_mail_icon_names':
      firetray.StatusIcon.loadThemedIcons();
    case 'only_favorite_folders':
    case 'message_count_type':
    case 'folder_count_recursive':
      firetray.Messaging.updateMsgCountWithCb();
      break;
    case 'app_mail_icon_names':
    case 'app_browser_icon_names':
    case 'app_default_icon_names':
    case 'app_icon_type':
      firetray.StatusIcon.loadThemedIcons();
    case 'app_icon_filename':
      firetray.Handler.setIconImageDefault();
      if (firetray.Handler.inMailApp)
        firetray.Messaging.updateMsgCountWithCb();
      break;

    case 'chat_icon_enable':
      firetray.Handler.toggleChat(firetray.Handler.isChatEnabled());
      break;

    case 'chat_icon_blink':
      if (!firetray.ChatStatusIcon.isBlinking)
        return;
      let startBlinking = firetray.Utils.prefService.getBoolPref('chat_icon_blink');
      if (startBlinking) {
        firetray.Chat.startGetAttention();
      } else {
        firetray.Chat.stopGetAttention();
      }
      break;

    case 'chat_icon_blink_style':
      if (!firetray.Utils.prefService.getBoolPref('chat_icon_blink') ||
          !firetray.ChatStatusIcon.isBlinking)
        break;

      firetray.ChatStatusIcon.toggleBlinkStyle(
        firetray.Utils.prefService.getIntPref("chat_icon_blink_style"));
      break;

    default:
    }
  });

firetray.MailChatPrefListener = new PrefListener(
  "mail.chat.",
  function(branch, name) {
    switch (name) {
    case 'enabled':
      let enableChatCond =
            (firetray.Handler.appHasChat &&
             firetray.Utils.prefService.getBoolPref("chat_icon_enable"));
      if (!enableChatCond) return;

      if (Services.prefs.getBoolPref("mail.chat.enabled")) {
        if (!firetray.Chat) {
          Cu.import("resource://firetray/FiretrayMessaging.jsm"); // needed for existsChatAccount
          Cu.import("resource://firetray/FiretrayChat.jsm");
          firetray.Utils.addObservers(firetray.Handler, [
            "account-added", "account-removed"]);
        }
        if (firetray.Handler.existsChatAccount())
          firetray.Handler.toggleChat(true);

      } else {
        firetray.Handler.toggleChat(false);
      }
      break;
    default:
    }
  });

firetray.VersionChangeHandler = {

  showReleaseNotes: function() {
    firetray.VersionChangeHandler.openTab(FIRETRAY_SPLASH_PAGE+"#release-notes");
  },

  openTab: function(url) {
    log.info("appId="+firetray.Handler.appId);
    if (firetray.Handler.appId === FIRETRAY_APP_DB['thunderbird']['id'])
      this.openMailTab(url);

    else if (firetray.Handler.appId === FIRETRAY_APP_DB['firefox']['id'] ||
             firetray.Handler.appId === FIRETRAY_APP_DB['seamonkey']['id'])
      this.openBrowserTab(url);

    else if (firetray.Handler.appId === FIRETRAY_APP_DB['zotero']['id']) {
      let win = null;
      if (win = Services.wm.getMostRecentWindow("zotero:basicViewer")) {
        win.loadURI(uri);
      } else if (win = Services.wm.getMostRecentWindow("navigator:browser")) {
        win.openDialog("chrome://zotero/content/standalone/basicViewer.xul",
                       "basicViewer",
                       "chrome,resizable,centerscreen,menubar,scrollbars", url);
      } else
        log.error("Zotero main-window not found");

    } else {
      this.openSystemBrowser(url);
    }
  },

  openMailTab: function(url) {
    let mail3PaneWindow = Services.wm.getMostRecentWindow("mail:3pane");
    if (mail3PaneWindow) {
      var tabmail = mail3PaneWindow.document.getElementById("tabmail");
      mail3PaneWindow.focus();
    }

    if (tabmail) {
      firetray.Handler.timers['open-mail-tab'] =
        firetray.Utils.timer(FIRETRAY_DELAY_STARTUP_MILLISECONDS,
          Ci.nsITimer.TYPE_ONE_SHOT, function() {
            tabmail.openTab("contentTab", {contentPage: url});
          });
    }
  },

  openBrowserTab: function(url) {
    let win = Services.wm.getMostRecentWindow("navigator:browser");
    if (win) {
      var mainWindow = win.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
            .getInterface(Components.interfaces.nsIWebNavigation)
            .QueryInterface(Components.interfaces.nsIDocShellTreeItem)
            .rootTreeItem
            .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
            .getInterface(Components.interfaces.nsIDOMWindow);

      mainWindow.setTimeout(function(win){
        mainWindow.gBrowser.selectedTab = mainWindow.gBrowser.addTab(url);
      }, 1000);
    }
  },

  openSystemBrowser: function(url) {
    try {
      var uri = Services.io.newURI(url, null, null);
      var handler = Cc['@mozilla.org/uriloader/external-protocol-service;1']
            .getService(Ci.nsIExternalProtocolService)
            .getProtocolHandlerInfo('http');
      handler.preferredAction = Ci.nsIHandlerInfo.useSystemDefault;
      handler.launchWithURI(uri, null);
    } catch (e) {log.error(e);}
  },

  tryEraseOldOptions: function() {
    let v03Options = [
      "close_to_tray", "minimize_to_tray", "start_minimized", "confirm_exit",
      "restore_to_next_unread", "mail_count_type", "show_mail_count",
      "dont_count_spam", "dont_count_archive", "dont_count_drafts",
      "dont_count_sent", "dont_count_templates", "show_mail_notification",
      "show_icon_only_minimized", "use_custom_normal_icon",
      "use_custom_special_icon", "custom_normal_icon", "custom_special_icon",
      "text_color", "scroll_to_hide", "scroll_action", "grab_multimedia_keys",
      "hide_show_mm_key", "accounts_to_exclude" ];
    let v040b2Options = [ 'mail_notification' ];
    let oldOptions = v03Options.concat(v040b2Options);

    for (let i = 0, length = oldOptions.length; i<length; ++i) {
      try {
        let option = oldOptions[i];
        firetray.Utils.prefService.clearUserPref(option);
      } catch (x) {}
    }
  },

  correctMailNotificationType: function() {
    let msgCountType = firetray.Utils.prefService.getIntPref('message_count_type');
    let mailNotificationType = firetray.Utils.prefService.getIntPref('mail_notification_type');
    if (msgCountType === FIRETRAY_MESSAGE_COUNT_TYPE_NEW &&
        mailNotificationType === FIRETRAY_NOTIFICATION_MESSAGE_COUNT) {
      firetray.Utils.prefService.setIntPref('mail_notification_type',
        FIRETRAY_NOTIFICATION_NEWMAIL_ICON);
      log.warn("mail notification type set to newmail icon.");
    }
  },

  correctMailServerTypes: function() {
    let mailAccounts = firetray.Utils.getObjPref('mail_accounts');
    let serverTypes = mailAccounts["serverTypes"];
    if (!serverTypes["exquilla"]) {
      serverTypes["exquilla"] = {"order":6,"excluded":true};
      let prefObj = {"serverTypes":serverTypes, "excludedAccounts":mailAccounts["excludedAccounts"]};
      firetray.Utils.setObjPref('mail_accounts', prefObj);
      log.warn("mail server types corrected");
    }
  }

};
