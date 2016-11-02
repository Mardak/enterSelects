/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {Cu} = require("chrome");
Cu.import("resource://gre/modules/PlacesUtils.jsm", this);
Cu.import("resource://gre/modules/Services.jsm", this);

const {makeWindowHelpers} = require("./makeWindowHelpers");
const {watchWindows} = require("./watchWindows");

// Milliseconds to wait for results after pressing enter
const MAX_WAIT_FOR_RESULTS = 350;

const cachedKeywords = new Map();
function isKeyword(keyword) {
  // Immediately handle the keyword if we've checked it before
  if (cachedKeywords.has(keyword)) {
    return cachedKeywords.get(keyword);
  }

  // Check for search engine keyword and remember if it is
  if (Services.search.getEngineByAlias(keyword) != null) {
    cachedKeywords.set(keyword, true);
    return true;
  }

  // Asynchronously check for bookmark keywords
  PlacesUtils.keywords.fetch(keyword).then(result => {
    cachedKeywords.set(keyword, !!result);
  });

  // Just return false immediately and correctly handle in the future
  return false;
}

// Pre-fetch existing keywords to the cache
PlacesUtils.promiseDBConnection().then(db => db.execute(`
  SELECT keyword
  FROM moz_keywords
`)).then(rows => rows.forEach(row => cachedKeywords.set(
  row.getResultByName("keyword"), true)));

// Add enter selects functionality to all browser windows
watchWindows(function(window) {
  let {change, defer, listen} = makeWindowHelpers(window);
  let {gURLBar} = window;
  let {popup} = gURLBar;

  // Remember if the next result should be selected
  let selectNext = false;

  // Remember values to restore them if necessary
  let origSearch = "";
  let origValue = "";

  // Starting with Firefox 48 Beta 3, the only behavior is unified complete, so
  // automatically select the 1th result (default search is 0th result)
  let targetIndex = 1;

  // Figure out what part the user actually typed
  function getTyped() {
    let {value} = gURLBar;
    if (gURLBar.selectionEnd == value.length)
      value = value.slice(0, gURLBar.selectionStart);
    return value.trim();
  }

  // Determine if the location bar frontend will take care of the input
  function willHandle(search) {
    // Potentially it's a url if there's no spaces
    if (search.match(/ /) == null) {
      try {
        // Quit early if the input is already a URI
        return Services.io.newURI(search, null, null);
      }
      catch(ex) {}

      try {
        // Quit early if the input is domain-like (e.g., site.com/page)
        return Services.eTLD.getBaseDomainFromHost(search);
      }
      catch(ex) {}
    }

    // Check if the first word is a keyword (search or bookmark)
    if (isKeyword(search.split(/\s+/)[0])) {
      return true;
    }

    return false;
  }

  // Detect when results are added to autoselect the first one
  change(popup, "_appendCurrentResult", function(orig) {
    return function() {
      // Run the original first to get results added
      orig.apply(this, arguments);

      // Don't bother if something is already selected
      if (popup.selectedIndex >= targetIndex)
        return;

      // Make sure there's results
      if (popup._matchCount == 0)
        return;

      // Don't auto-select if we have a user-typed url
      let currentSearch = getTyped();
      if (willHandle(currentSearch))
        return;

      // Store these to resore if necessary when moving out of the popup
      origSearch = currentSearch;
      origValue = gURLBar.value;

      // We passed all the checks, so pretend the user has the first result
      // selected, so this causes the UI to show the selection style
      popup.selectedIndex = targetIndex;

      if (selectNext) {
        selectNext = false;
        defer(_ => gURLBar.controller.handleEnter(true));
      }
    };
  });

  // Detect the user selecting results from the list
  listen(gURLBar, "keydown", function(event) {
    switch (event.keyCode) {
      // For horizontal movement keys, unselect the first item to allow editing
      case event.DOM_VK_LEFT:
      case event.DOM_VK_RIGHT:
      case event.DOM_VK_HOME:
        popup.selectedIndex = -1;
        return;

      // For vertical movement keys, restore the inline completion if necessary
      case event.DOM_VK_UP:
      case event.DOM_VK_DOWN:
      case event.DOM_VK_PAGE_UP:
      case event.DOM_VK_PAGE_DOWN:
      case event.DOM_VK_TAB:
        // Wait for the actual movement to finish before checking
        defer(function() {
          // If we have nothing selected in the popup, restore the completion
          if (popup.selectedIndex == -1 && gURLBar.popupOpen) {
            gURLBar.textValue = origValue;
            gURLBar.selectionStart = origSearch.length;
          }
        });
        return;

      // We're interested in handling enter (return)
      case event.DOM_VK_RETURN:
        // Ignore special key combinations
        if (event.shiftKey || event.ctrlKey || event.metaKey)
          return;

        // Detect if there's no results so yet, so we're waiting for more
        let {controller} = gURLBar;
        let {matchCount, searchStatus} = controller;
        if (matchCount == 0 && searchStatus <= controller.STATUS_SEARCHING) {
          // If the location bar will handle the search, don't bother waiting
          let enteredSearch = getTyped();
          if (willHandle(enteredSearch))
            return;

          // Stop the location bar from handling search because we want results
          event.preventDefault();

          // Remember that the next result will be selected
          selectNext = true;

          // In-case there are no results after a short wait, just load search
          defer(function() {
            if (enteredSearch == getTyped() && controller.matchCount == 0) {
              selectNext = false;
              gURLBar.onTextEntered();
            }
          // Wait a shorter amount of time the more the user types
          }, MAX_WAIT_FOR_RESULTS / enteredSearch.length);

          // Do nothing now until more results are appended
          return;
        }

        // For the auto-selected first result, act as if the user pressed down
        // to select it so that 1) the urlbar will have the correct url for the
        // enter handler to load and 2) the adaptive learning code-path will
        // correctly associate the user's input to the selected popup item.
        if (popup.selectedIndex == targetIndex) {
          popup.selectedIndex = targetIndex - 1;
          controller.handleKeyNavigation(event.DOM_VK_DOWN);
        }
        break;
    }
  }, false);
});
