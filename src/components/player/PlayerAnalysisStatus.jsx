export default function PlayerAnalysisStatus({
  analysisRunning,
  analysisJob,
  analysisState,
  onCancelAnalysis
}) {
  return (
    <>
      {analysisRunning ? (
        <div className="player-analysis-status">
          <span className="player-analysis-spinner" aria-hidden="true" />
          <div>
            <strong>{analysisJob?.stage || '视频理解'}</strong>
            <span>{analysisJob?.message || '正在分析当前视频'}</span>
          </div>
          <button type="button" onClick={onCancelAnalysis} disabled={analysisJob?.canCancel === false}>取消本次分析</button>
        </div>
      ) : null}

      {analysisState.status === 'error' && analysisState.error ? (
        <div className="player-analysis-error">
          <span>{analysisState.error}</span>
        </div>
      ) : null}
    </>
  )
}
