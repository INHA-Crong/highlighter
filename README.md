# highlighter

글쓰기 편집기 본문을 읽어 문장 단위로 하이라이트하는 Chrome 확장(MV3) 스파이크.
티스토리, 네이버 블로그 편집기에서 동작 확인.

- `content.js`: 본문 읽기(DOM·커서·실행 취소 기록 불변), 문장 분리(`. ? !` 뒤 공백·줄바꿈), CSS Custom Highlight API로 표시. 네이버 SmartEditor ONE용 사이트 어댑터 포함. 현재 분류기는 키워드 목업.
- `highlight.css`: `::highlight()` 스타일. 페이지 CSP를 피하려고 manifest로 주입.
- `index.html`: textarea, contenteditable, iframe designMode, Shadow DOM, 재렌더링 편집기 시험 페이지.

## 설치
chrome://extensions → 개발자 모드 → "압축해제된 확장 프로그램을 로드합니다" → 이 폴더 선택.

`matches: <all_urls>`는 개발용. 배포 시 지원 사이트로 좁힐 것.
