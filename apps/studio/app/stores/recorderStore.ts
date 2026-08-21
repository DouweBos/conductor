import { create } from "zustand";

interface RecorderState {
  recording: boolean;
}

const store = create<RecorderState>(() => ({ recording: false }));

export const useRecording = () => store((s) => s.recording);
export const isRecording = () => store.getState().recording;
export const toggleRecording = () => store.setState((s) => ({ recording: !s.recording }));
export const setRecording = (recording: boolean) => store.setState({ recording });
