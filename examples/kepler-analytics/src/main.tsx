import { Provider } from "react-redux";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";
import { store } from "./store";

createRoot(document.getElementById("root")!).render(
  <Provider store={store}>
    <App />
  </Provider>,
);
