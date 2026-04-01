import { enhanceReduxMiddleware, keplerGlReducer } from "@kepler.gl/reducers";
import { taskMiddleware } from "react-palm/tasks";
import { applyMiddleware, combineReducers, compose, createStore } from "redux";

const reducer = combineReducers({
  keplerGl: keplerGlReducer,
});

const middleware = enhanceReduxMiddleware([taskMiddleware]);

export const store = createStore(reducer, compose(applyMiddleware(...middleware)));
