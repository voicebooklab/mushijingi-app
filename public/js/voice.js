// 音声入力（Web Speech API・Chrome標準機能・追加費用なし）
// text/textareaの入力欄すべてに🎤ボタンを自動で付ける
(function () {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return; // 非対応ブラウザでは何もしない（フォームは通常通り使える）

  function attachMic(el) {
    if (el.dataset.micAttached) return;
    el.dataset.micAttached = '1';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mic-btn';
    btn.textContent = '🎤 音声入力';
    el.insertAdjacentElement('afterend', btn);

    let recognition = null;
    let listening = false;

    btn.addEventListener('click', () => {
      if (listening) {
        recognition && recognition.stop();
        return;
      }
      recognition = new SpeechRecognition();
      recognition.lang = 'ja-JP';
      recognition.continuous = false;   // 一度の発話で自動的に終わる
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      let handled = false; // このセッションで一度だけ反映する（重複入力の防止）

      recognition.onstart = () => {
        listening = true;
        handled = false;
        btn.classList.add('mic-active');
        btn.textContent = '⏺ 聞き取り中…（もう一度押すと終了）';
      };
      recognition.onend = () => {
        listening = false;
        btn.classList.remove('mic-active');
        btn.textContent = '🎤 音声入力';
      };
      recognition.onerror = (e) => {
        listening = false;
        btn.classList.remove('mic-active');
        btn.textContent = '🎤 音声入力';
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          alert('マイクが使えませんでした。ブラウザのマイク許可設定、または接続がhttps/localhostかどうかを確認してください。');
        }
      };
      recognition.onresult = (event) => {
        if (handled) return; // 同じ発話に対してonresultが複数回来ても、最初の1回だけ反映する
        // 直近（最新）の確定結果だけを見る。event.results[0]を毎回見ると同じ内容を繰り返し拾ってしまう
        const result = event.results[event.results.length - 1];
        if (!result.isFinal) return;
        handled = true;
        const text = result[0].transcript.trim();
        if (!text) return;
        if (el.value && el.tagName === 'TEXTAREA') {
          el.value += (el.value.endsWith('\n') ? '' : '\n') + text;
        } else if (el.value) {
          el.value += (el.value.endsWith(' ') ? '' : ' ') + text;
        } else {
          el.value = text;
        }
        recognition.stop(); // 1回反映したら即座に打ち切り、続けて拾ってしまうのを防ぐ
      };
      recognition.start();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('textarea, input[type="text"]').forEach(attachMic);
  });
})();
